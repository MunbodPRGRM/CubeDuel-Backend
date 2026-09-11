/**
 * ทดสอบโหลด — เปิดห้องสร้างเอง 1v1 **พร้อมกัน 50 ห้อง** (100 socket) แล้วเล่นจนจบผ่าน Socket.IO จริง
 * เพื่อตอบคำถามของเฟส 10: "50 ห้องพร้อมกันแล้วเวลาที่จับได้ยังตรงไหม" (เฟส 10 ก้อนที่ 4 — ADR-055)
 *
 * ต้องมี server รันอยู่บน **เครื่องเดียวกัน** (`npm run dev`) + DB ที่ migrate แล้ว
 * รัน:  npm run load:rooms                 สร้างบัญชี load_* → เล่นหนึ่งรอบ → ลบทิ้งทั้งหมด
 *       npm run load:rooms -- --keep       ไม่ลบบัญชีกับแมตช์หลังจบ (ไว้เปิดดูใน DB)
 *       npm run load:rooms -- --clean      ลบของที่ค้างจาก --keep
 * ปรับได้ด้วย env:  LOAD_ROOMS=50  LOAD_MOVE_GAP_MS=200
 *
 * **เซ็น access token เองด้วย `JWT_ACCESS_SECRET` ใน `.env`** แทนการล็อกอินผ่าน REST —
 * ล็อกอิน 100 บัญชีติด rate limit 10 ครั้ง/15 นาทีต่อ IP · ผลคือใช้ได้กับ server ที่อ่าน `.env`
 * ไฟล์เดียวกันเท่านั้น (ADR-055 ข้อ 6)
 *
 * วัดอะไร:
 *   - **ความคลาดของเวลาแก้** = solveTimeMs ที่ server ตัดสิน − (เวลาที่ client ส่ง solve:solved − serverStartTs)
 *     client กับ server อยู่เครื่องเดียวกันนาฬิกาจึงตรงกันเป๊ะ ส่วนต่างคือเวลาที่ event ค้างอยู่ในสาย
 *     และในคิวของ server ล้วน ๆ · ไม่ส่ง `lastRttMs` จึงไม่มีการชดเชย latency มาปน
 *   - ตัวจับเวลาของ server ช้ากว่ากำหนดเท่าไร (serverStartTs − endsAtTs ของ inspection)
 *   - RTT ของ net:ping · เวลาส่งต่อ opponent:move · เวลาจากกดเริ่มจนได้ scramble
 *   - ทุกห้องจบ · ทุกแมตช์ลง DB ด้วยเวลาตรงกับที่ประกาศ · ไม่มี error สักตัว
 */
import { CubeType, PrismaClient, UserRole } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import { COUNTDOWN_MS, INSPECTION_MS } from '../src/constants.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { toDbSeconds } from '../src/lib/ranking.js';
import {
  API,
  check,
  connect,
  emit,
  sendMoves,
  solutionMoves,
  summary,
  waitFor,
  type Ack,
  type SmokeMatchResult,
} from './smoke-helpers.js';

const ROOMS = Number(process.env.LOAD_ROOMS ?? 50);
const MOVE_GAP_MS = Number(process.env.LOAD_MOVE_GAP_MS ?? 200);
/** ของจริงส่งทุก 10 วินาที (`SocketProvider.tsx`) — ถี่กว่า 5 เท่าให้มีตัวอย่างพอและกดดันกว่าของจริง */
const PING_EVERY_MS = 2_000;

/**
 * เกณฑ์ผ่าน — เวลาที่ตัดสินแพ้ชนะลง DB ละเอียดถึง 10 ms · เพดานชดเชย latency ของจริงคือ 150 ms
 * ความคลาด 50 ms จึงยังห่างเพดานนั้นสามเท่า และตัวเลขที่เกินนี้บนเครื่องเดียวกันแปลว่า
 * event loop ของ server เริ่มค้างแล้ว ไม่ใช่เรื่องของเน็ต
 */
const LIMIT = { solveErrorMs: 50, timerLateMs: 50, pingP95Ms: 100, relayP95Ms: 100 };

const PREFIX = 'load_';
/** ชื่อบัญชีที่สคริปต์นี้สร้าง — `--clean` ลบเฉพาะที่ตรงรูปนี้เป๊ะ (`_` ใน LIKE เป็น wildcard) */
const LOAD_USERNAME = /^load_\d{3,}$/;

const CUBE_TYPES = ['2x2x2', '3x3x3', 'pyraminx', 'pyramorphix'] as const;
type LoadCubeType = (typeof CUBE_TYPES)[number];
const PRISMA_CUBE_TYPES = [
  CubeType.CUBE_2X2X2,
  CubeType.CUBE_3X3X3,
  CubeType.PYRAMINX,
  CubeType.PYRAMORPHIX,
];

const prisma = new PrismaClient();

interface LoadUser {
  userId: number;
  username: string;
}

interface Seat {
  user: LoadUser;
  socket: Socket;
  errors: unknown[];
}

interface SolveRecord {
  userId: number;
  clientSendTs: number;
  ackTs: number;
  ack: Ack<{ solveTimeMs: number; rankNo: number }>;
}

interface RoomRun {
  index: number;
  cubeType: LoadCubeType;
  host: Seat;
  guest: Seat;
  opened: boolean;
  startEmitTs: number | null;
  loadingTs: number | null;
  countdownStartsAtTs: number | null;
  inspectionEndsAtTs: number | null;
  serverStartTs: number | null;
  solves: SolveRecord[];
  finished: SmokeMatchResult | null;
  failure: string | null;
}

const pingRttMs: number[] = [];
const relayLagMs: number[] = [];

// ------------------------------------------------------------------ บัญชีทดสอบ

async function ensureUsers(count: number): Promise<LoadUser[]> {
  const usernames = Array.from(
    { length: count },
    (_, i) => `${PREFIX}${String(i).padStart(3, '0')}`,
  );
  await prisma.user.createMany({
    data: usernames.map((username) => ({
      username,
      email: `${username}@load.local`,
      // ล็อกอินไม่ได้และไม่ควรล็อกอินได้ — ใช้ token ที่สคริปต์เซ็นเองเท่านั้น
      passwordHash: null,
      nickname: username,
    })),
    skipDuplicates: true,
  });

  const users = await prisma.user.findMany({
    where: { username: { in: usernames } },
    select: { userId: true, username: true },
    orderBy: { username: 'asc' },
  });
  // ผู้ใช้ 1 คน = Rating 4 แถวเสมอ — `joinAsPlayer()` อ่าน Elo ของประเภทที่เล่นตอนเข้าห้อง
  await prisma.rating.createMany({
    data: users.flatMap((user) =>
      PRISMA_CUBE_TYPES.map((cubeType) => ({ userId: user.userId, cubeType, eloRating: 1000 })),
    ),
    skipDuplicates: true,
  });
  return users;
}

async function clean(): Promise<number> {
  const candidates = await prisma.user.findMany({
    where: { username: { startsWith: PREFIX } },
    select: { userId: true, username: true },
  });
  const ids = candidates.filter((u) => LOAD_USERNAME.test(u.username)).map((u) => u.userId);
  if (ids.length === 0) return 0;

  // MatchFlag กับ Match ตั้ง onDelete: Restrict ไว้ → ลบจากปลายทางเข้าหาตัวผู้ใช้
  await prisma.matchFlag.deleteMany({ where: { userId: { in: ids } } });
  await prisma.match.deleteMany({
    where: { OR: [{ player1Id: { in: ids } }, { player2Id: { in: ids } }] },
  });
  await prisma.rating.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { userId: { in: ids } } });
  return ids.length;
}

function tokenFor(user: LoadUser, role: 'member' | 'admin' = 'member'): string {
  return signAccessToken({ sub: user.userId, username: user.username, role });
}

// ------------------------------------------------------------------ ตัวเลข

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
  return { n: sorted.length, min: sorted[0] ?? NaN, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? NaN };
}

function report(label: string, values: number[]) {
  const s = summarize(values);
  console.log(
    `   ${label}\n      n=${s.n} · ต่ำสุด ${s.min} · กลาง ${s.p50} · p95 ${s.p95} · สูงสุด ${s.max} ms`,
  );
  return s;
}

// ------------------------------------------------------------------ หนึ่งห้อง

/**
 * 3x3x3 ที่ใช้น้อยกว่า 18 ท่าติดเกณฑ์ soft `LOW_MOVE_COUNT` — เติมคู่ `U U'` ที่หักล้างกันเอง
 * ต่อท้ายให้ถึง 20 ท่า ไม่งั้นทุกรอบจะทิ้ง MatchFlag ไว้เต็มหน้าแอดมิน
 */
function padMoves(cubeType: LoadCubeType, moves: string[]): string[] {
  if (cubeType !== '3x3x3') return moves;
  const padded = [...moves];
  while (padded.length < 20) padded.push('U', "U'");
  return padded;
}

async function openRoom(run: RoomRun): Promise<void> {
  const created = await emit<{ roomId: number; roomCode: string }>(run.host.socket, 'room:create', {
    cubeType: run.cubeType,
    kind: 'custom',
    maxPlayers: 2,
  });
  if (!created.ok) throw new Error(`room:create ${created.error.code}`);

  const joined = await emit(run.guest.socket, 'room:join', {
    roomCode: created.data.roomCode,
    as: 'player',
  });
  if (!joined.ok) throw new Error(`room:join ${joined.error.code}`);

  const host = run.host.socket;
  host.on('match:countdown', (p: { startsAtTs: number }) => (run.countdownStartsAtTs = p.startsAtTs));
  host.on('match:inspection_started', (p: { endsAtTs: number }) => (run.inspectionEndsAtTs = p.endsAtTs));
  run.opened = true;
}

async function solveAs(run: RoomRun, seat: Seat, moves: string[], gapMs: number): Promise<void> {
  await sendMoves(seat.socket, moves, gapMs);
  const clientSendTs = Date.now();
  const ack = await emit<{ solveTimeMs: number; rankNo: number }>(seat.socket, 'solve:solved', {
    seq: moves.length,
    moveCount: moves.length,
    clientTs: clientSendTs,
  });
  run.solves.push({ userId: seat.user.userId, clientSendTs, ackTs: Date.now(), ack });
}

async function playRound(run: RoomRun): Promise<void> {
  const { host, guest } = run;
  // ดักทุก event ไว้ก่อนสั่งเริ่ม — server ส่งออกก่อนที่ ack ของ room:start จะกลับมาถึง
  const loading = waitFor<{ scramble: string }>(host.socket, 'match:loading', 60_000);
  const startedHost = waitFor<{ serverStartTs: number }>(host.socket, 'match:started', 90_000);
  const startedGuest = waitFor<{ serverStartTs: number }>(guest.socket, 'match:started', 90_000);
  const finished = waitFor<SmokeMatchResult>(host.socket, 'match:finished', 150_000);

  run.startEmitTs = Date.now();
  const started = await emit(host.socket, 'room:start', {});
  if (!started.ok) throw new Error(`room:start ${started.error.code}`);

  const loaded = await loading;
  if (!loaded) throw new Error('ไม่ได้รับ match:loading');
  run.loadingTs = Date.now();
  await Promise.all([emit(host.socket, 'solve:ready', {}), emit(guest.socket, 'solve:ready', {})]);

  const [a, b] = await Promise.all([startedHost, startedGuest]);
  if (!a || !b) throw new Error('ไม่ได้รับ match:started');
  run.serverStartTs = a.serverStartTs;

  // guest ช้ากว่า 30% → host จบก่อน แล้ว guest จบระหว่างนับถอยหลัง 10 วิ ได้ครบทุกช่วงของ state machine
  const moves = padMoves(run.cubeType, solutionMoves(loaded.scramble));
  await Promise.all([
    solveAs(run, host, moves, MOVE_GAP_MS),
    solveAs(run, guest, moves, Math.round(MOVE_GAP_MS * 1.3)),
  ]);

  run.finished = await finished;
  if (!run.finished) throw new Error('ไม่ได้รับ match:finished');
}

// ------------------------------------------------------------------ ทั้งชุด

async function dashboard(adminToken: string): Promise<{ activeRooms: number; onlineUsers: number } | null> {
  const res = await fetch(`${API}/admin/dashboard`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const body = (await res.json()) as { data?: { activeRooms: number; onlineUsers: number } };
  return body.data ?? null;
}

async function run(): Promise<void> {
  const users = await ensureUsers(ROOMS * 2);
  const admin = await prisma.user.findFirst({
    where: { role: UserRole.ADMIN, deletedAt: null },
    select: { userId: true, username: true },
  });
  if (!admin) throw new Error('ไม่พบบัญชีแอดมิน — รัน npm run seed ก่อน');

  // ตัววัดว่าตัวสคริปต์เองค้างไหม — ถ้าค้าง ตัวเลขข้างล่างจะแย่เกินจริง ไม่ใช่ความผิดของ server
  let clientLagMaxMs = 0;
  let lastTick = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    clientLagMaxMs = Math.max(clientLagMaxMs, now - lastTick - 100);
    lastTick = now;
  }, 100);

  console.log(`\n[load] ต่อ socket ${users.length} ตัวพร้อมกัน...`);
  const connectT0 = performance.now();
  const seats: Seat[] = await Promise.all(
    users.map(async (user) => {
      const socket = await connect(tokenFor(user));
      const seat: Seat = { user, socket, errors: [] };
      socket.on('error', (error: unknown) => seat.errors.push(error));
      socket.on('opponent:move', (p: { serverTs: number }) => relayLagMs.push(Date.now() - p.serverTs));
      return seat;
    }),
  );
  check(
    `ต่อ socket ครบ ${users.length} ตัว (${Math.round(performance.now() - connectT0)} ms)`,
    seats.length === users.length,
  );

  const pingTimer = setInterval(() => {
    for (const seat of seats) {
      const sentTs = Date.now();
      seat.socket.emit('net:ping', { clientTs: sentTs }, () => pingRttMs.push(Date.now() - sentTs));
    }
  }, PING_EVERY_MS);

  const runs: RoomRun[] = Array.from({ length: ROOMS }, (_, index) => ({
    index,
    cubeType: CUBE_TYPES[index % CUBE_TYPES.length]!,
    host: seats[index * 2]!,
    guest: seats[index * 2 + 1]!,
    opened: false,
    startEmitTs: null,
    loadingTs: null,
    countdownStartsAtTs: null,
    inspectionEndsAtTs: null,
    serverStartTs: null,
    solves: [],
    finished: null,
    failure: null,
  }));

  try {
    console.log(`[load] เปิด ${ROOMS} ห้อง...`);
    await Promise.all(
      runs.map((r) => openRoom(r).catch((e: Error) => void (r.failure = `เปิดห้อง: ${e.message}`))),
    );
    const opened = runs.filter((r) => r.opened);
    check(`เปิดห้องครบ ${ROOMS} ห้อง`, opened.length === ROOMS, runs.map((r) => r.failure).filter(Boolean));

    const before = await dashboard(tokenFor(admin, 'admin'));
    check(
      `แดชบอร์ดแอดมินเห็นห้องเปิดอยู่ ≥ ${ROOMS} · คนออนไลน์ ≥ ${ROOMS * 2}`,
      !!before && before.activeRooms >= ROOMS && before.onlineUsers >= ROOMS * 2,
      before,
    );

    console.log(`[load] กดเริ่มทุกห้องพร้อมกัน แล้วเล่นจนจบ (ราว 25 วินาที)...`);
    const roundT0 = performance.now();
    await Promise.all(
      opened.map((r) => playRound(r).catch((e: Error) => void (r.failure = e.message))),
    );
    console.log(`[load] จบทุกห้องใน ${((performance.now() - roundT0) / 1000).toFixed(1)} วินาที`);

    await analyse(runs);
  } finally {
    clearInterval(pingTimer);
    clearInterval(lagTimer);
    await Promise.all(seats.map((seat) => emit(seat.socket, 'room:leave', {})));
    for (const seat of seats) seat.socket.disconnect();
  }

  console.log(
    `\n   ตัวสคริปต์ค้างนานสุด ${Math.round(clientLagMaxMs)} ms ` +
      '(ถ้าเกินราว 50 ms ตัวเลขข้างบนแย่เกินจริงเพราะฝั่งยิงเอง ไม่ใช่ server)',
  );
}

async function analyse(runs: RoomRun[]): Promise<void> {
  const failures = runs.filter((r) => r.failure).map((r) => `ห้อง ${r.index} (${r.cubeType}): ${r.failure}`);
  check(`ทุกห้องเล่นจนได้ match:finished (${runs.length - failures.length}/${runs.length})`, failures.length === 0, failures);

  const solves = runs.flatMap((r) => r.solves.map((s) => ({ run: r, solve: s })));
  const okSolves = solves.filter((x) => x.solve.ack.ok);
  check(
    `solve:solved ผ่านครบ ${runs.length * 2} ครั้ง (${okSolves.length})`,
    okSolves.length === runs.length * 2,
    solves.filter((x) => !x.solve.ack.ok).map((x) => x.solve.ack),
  );

  console.log('\n── ผลวัด');
  const solveError = okSolves.map(({ run, solve }) =>
    solve.ack.ok ? solve.ack.data.solveTimeMs - (solve.clientSendTs - run.serverStartTs!) : NaN,
  );
  const err = report('ความคลาดของเวลาแก้ (server ตัดสิน − เวลาจริงที่ client ส่ง)', solveError);
  const ackLatency = report(
    'solve:solved → ได้ ack กลับ (รวม replay move stream ด้วย cubing.js)',
    okSolves.map(({ solve }) => solve.ackTs - solve.clientSendTs),
  );
  const timerLate = report(
    'ตัวจับเวลา inspection 15 วิ ของ server ช้ากว่ากำหนด',
    runs
      .filter((r) => r.serverStartTs !== null && r.inspectionEndsAtTs !== null)
      .map((r) => r.serverStartTs! - r.inspectionEndsAtTs!),
  );
  const countdownLate = report(
    'ตัวจับเวลานับถอยหลัง 3 วิ ของ server ช้ากว่ากำหนด',
    runs
      .filter((r) => r.countdownStartsAtTs !== null && r.inspectionEndsAtTs !== null)
      .map((r) => r.inspectionEndsAtTs! - INSPECTION_MS - (r.countdownStartsAtTs! + COUNTDOWN_MS)),
  );
  report(
    'กดเริ่ม → ได้ match:loading (รวม generate scramble)',
    runs.filter((r) => r.loadingTs !== null).map((r) => r.loadingTs! - r.startEmitTs!),
  );
  const ping = report('RTT ของ net:ping ระหว่างแข่ง', pingRttMs);
  const relay = report('opponent:move ส่งต่อถึงอีกฝั่ง (นับจาก serverTs)', relayLagMs);

  console.log('');
  check(`ความคลาดของเวลาแก้ไม่เกิน ${LIMIT.solveErrorMs} ms ทุกครั้ง (สูงสุด ${err.max} ms)`, err.max <= LIMIT.solveErrorMs);
  check(`ไม่มีเวลาแก้ที่ server จับได้เร็วกว่าความจริง (ต่ำสุด ${err.min} ms)`, err.min >= 0);
  check(
    `ตัวจับเวลาของ server ช้ากว่ากำหนดไม่เกิน ${LIMIT.timerLateMs} ms (inspection ${timerLate.max} · countdown ${countdownLate.max})`,
    timerLate.max <= LIMIT.timerLateMs && countdownLate.max <= LIMIT.timerLateMs,
  );
  check(`RTT p95 ไม่เกิน ${LIMIT.pingP95Ms} ms (${ping.p95})`, ping.p95 <= LIMIT.pingP95Ms);
  check(`ส่งต่อ move p95 ไม่เกิน ${LIMIT.relayP95Ms} ms (${relay.p95})`, relay.p95 <= LIMIT.relayP95Ms);
  console.log(`   (ack ของ solve:solved ช้าสุด ${ackLatency.max} ms — ไม่กระทบเวลาเพราะ server จดเวลาก่อน replay)`);

  // ผลที่ประกาศในห้องต้องตรงกับที่ตอบใน ack · และตรงกับที่ลง DB
  const ackTimeOf = new Map<number, number>();
  for (const { solve } of okSolves) if (solve.ack.ok) ackTimeOf.set(solve.userId, solve.ack.data.solveTimeMs);

  const finished = runs.filter((r) => r.finished);
  const announcedMismatch = finished.filter(
    (r) =>
      r.finished!.results.length !== 2 ||
      r.finished!.results.some((x) => x.solveTimeMs !== ackTimeOf.get(x.userId)),
  );
  check('match:finished ประกาศเวลาตรงกับ ack ของทุกคน', announcedMismatch.length === 0, announcedMismatch.map((r) => r.index));

  const matchIds = finished.map((r) => r.finished!.matchId).filter((id): id is number => id !== null);
  check(`ทุกห้องได้ matchId กลับมา (${matchIds.length}/${finished.length})`, matchIds.length === finished.length);

  const rows = await prisma.match.findMany({
    where: { matchId: { in: matchIds } },
    select: {
      matchId: true,
      roomType: true,
      player1Id: true,
      player2Id: true,
      player1Time: true,
      player2Time: true,
    },
  });
  const dbMismatch = rows.filter((row) => {
    const expect = (userId: number) => toDbSeconds(ackTimeOf.get(userId) ?? NaN);
    return (
      row.roomType !== 'CUSTOM' ||
      Number(row.player1Time) !== expect(row.player1Id) ||
      Number(row.player2Time) !== expect(row.player2Id)
    );
  });
  check(
    `แมตช์ลง DB ครบ ${matchIds.length} แถว เวลาตรงกับที่ประกาศทุกแถว`,
    rows.length === matchIds.length && dbMismatch.length === 0,
    dbMismatch.map((row) => row.matchId),
  );

  const flags = await prisma.matchFlag.count({ where: { matchId: { in: matchIds } } });
  check(`ไม่มีแมตช์ไหนโดน anti-cheat flag (${flags})`, flags === 0);

  const socketErrors = runs.flatMap((r) => [...r.host.errors, ...r.guest.errors]);
  check(`ไม่มี event error ถึง client สักตัว (${socketErrors.length})`, socketErrors.length === 0, socketErrors.slice(0, 5));
}

async function main(): Promise<number> {
  if (process.argv.includes('--clean')) {
    console.log(`[load] ลบบัญชี ${PREFIX}* ไป ${await clean()} บัญชี`);
    return 0;
  }

  console.log(`[load] ${ROOMS} ห้อง · ${ROOMS * 2} socket · เว้นระหว่าง move ${MOVE_GAP_MS} ms`);
  try {
    await run();
  } finally {
    if (!process.argv.includes('--keep')) {
      console.log(`[load] ลบบัญชี ${PREFIX}* ไป ${await clean()} บัญชี (ใส่ --keep ถ้าอยากเก็บไว้ดู)`);
    }
  }
  return summary(`(${ROOMS} ห้องพร้อมกัน)`);
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error('[load] ล้มเหลว:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
