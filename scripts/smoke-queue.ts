/**
 * คิวจับคู่อัตโนมัติ — ยิงผ่าน Socket.IO เหมือนเบราว์เซอร์จริง (เฟส 5 ก้อนที่ 2)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * รันด้วย: npm run smoke:queue      (ใช้เวลาราว 90 วินาที เพราะรอ inspection 15 วิของจริง 2 รอบ)
 *
 * ครอบ: จับคู่จาก `queue:join` จริง · ห้องที่ได้เป็น competitive ไม่มีรหัสห้อง ·
 *       เริ่มเองหลัง MATCHED โดยไม่มีใครกด `room:start` · เล่นจนจบแล้ว Elo ขยับ ·
 *       `queue:status` · เข้าคิวซ้ำ · ออกจากคิว · คนละประเภทรูบิคไม่เจอกัน ·
 *       ช่วง Elo ขยายตามเวลารอ · หลุดระหว่างรอคิว · เข้าคิวตอนยังอยู่ในห้องเดิม
 */
import { CubeType, PrismaClient, RoomType } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import {
  API,
  check,
  connect,
  emit,
  login,
  sendMoves,
  solutionMoves,
  summary,
  waitFor,
  type SmokeMatchResult,
} from './smoke-helpers.js';

const CUBE_TYPE = '2x2x2';
const PRISMA_CUBE_TYPE = CubeType.CUBE_2X2X2;
const BASELINE_ELO = 1000;

const prisma = new PrismaClient();

interface Player {
  userId: number;
  username: string;
  socket: Socket;
}

interface Matched {
  roomId: number;
  cubeType: string;
  players: { userId: number; username: string; isHost: boolean; eloRating: number }[];
}

interface Snapshot {
  roomId: number;
  roomKind: string;
  roomCode: string | null;
  state: string;
  cubeType: string;
  matchId: number | null;
}

/** รูปของ `GET /matches/:matchId` (api-contract.md ข้อ 3) */
interface MatchDetail {
  matchId: number;
  roomType: string;
  ratingApplied: boolean;
  players: {
    userId: number;
    rankNo: number;
    solveTime: number | null;
    result: string;
    eloBefore: number | null;
    eloAfter: number | null;
    eloChange: number | null;
  }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openPlayer(username: string): Promise<Player> {
  const auth = await login(username);
  return { ...auth, username, socket: await connect(auth.token) };
}

/**
 * เก็บ `room:state` ทุกใบที่ผ่านเข้ามา — ต้องดักไว้ล่วงหน้า
 * เพราะ server ส่งตามหลัง `queue:matched` ทันที ดักทีหลังจะไม่ทัน
 */
function recordStates(socket: Socket): Snapshot[] {
  const seen: Snapshot[] = [];
  socket.on('room:state', (snapshot: Snapshot) => seen.push(snapshot));
  return seen;
}

function setElo(userId: number, elo: number) {
  return prisma.rating.update({
    where: { userId_cubeType: { userId, cubeType: PRISMA_CUBE_TYPE } },
    data: { eloRating: elo },
  });
}

function ratingOf(userId: number) {
  return prisma.rating.findUnique({
    where: { userId_cubeType: { userId, cubeType: PRISMA_CUBE_TYPE } },
  });
}

function joinQueue(player: Player, cubeType = CUBE_TYPE) {
  return emit<{ queuedAtTs: number; playersInQueue: number }>(player.socket, 'queue:join', {
    cubeType,
    kind: 'competitive',
  });
}

/** แก้คิวบ์ให้เสร็จจริงด้วยจังหวะเหมือนคนหมุน (ช้าพอไม่ให้ติดเกณฑ์ soft ของ anti-cheat) */
async function solve(player: Player, scramble: string): Promise<void> {
  const moves = solutionMoves(scramble);
  await sendMoves(player.socket, moves, 120);
  const solved = await emit(player.socket, 'solve:solved', {
    seq: moves.length,
    moveCount: moves.length,
    clientTs: Date.now(),
  });
  if (!solved.ok) throw new Error(`แจ้งแก้เสร็จไม่ผ่าน: ${solved.error.code}`);
}

async function main(): Promise<void> {
  console.log(`\n🎯 ทดสอบคิวจับคู่อัตโนมัติ (${CUBE_TYPE})\n`);

  const alice = await openPlayer('somchai');
  const bob = await openPlayer('malee');
  const carol = await openPlayer('nattapong');

  // ---------------------------------------------------------------- 1. จับคู่ + เล่นจนจบ
  console.log('รอบที่ 1 — เข้าคิวพร้อมกัน → จับคู่ → server เริ่มให้เอง → เล่นจนจบ');
  await Promise.all([setElo(alice.userId, BASELINE_ELO), setElo(bob.userId, BASELINE_ELO)]);

  const states = recordStates(alice.socket);
  const aliceMatched = waitFor<Matched>(alice.socket, 'queue:matched', 15_000);
  const bobMatched = waitFor<Matched>(bob.socket, 'queue:matched', 15_000);
  // ดัก match:loading ไว้ก่อน เพราะ server เริ่มเองหลัง MATCHED 2 วินาทีโดยไม่มีใครกดปุ่ม
  const loading = waitFor<{ scramble: string }>(alice.socket, 'match:loading', 20_000);

  const aliceJoin = await joinQueue(alice);
  const bobJoin = await joinQueue(bob);

  check('queue:join ตอบ ack สำเร็จทั้งสองฝั่ง', aliceJoin.ok && bobJoin.ok, {
    alice: aliceJoin,
    bob: bobJoin,
  });
  check(
    'คนที่สองเห็นว่ามีคนรออยู่ในคิวช่องเดียวกันแล้ว (playersInQueue = 2)',
    bobJoin.ok && bobJoin.data.playersInQueue === 2,
    bobJoin.ok ? bobJoin.data : bobJoin,
  );

  const [matchedA, matchedB] = await Promise.all([aliceMatched, bobMatched]);
  check('ทั้งสองฝั่งได้ queue:matched', matchedA !== null && matchedB !== null);
  check(
    'ได้ห้องเดียวกันและตรงประเภทที่เลือก',
    matchedA?.roomId === matchedB?.roomId && matchedA?.cubeType === CUBE_TYPE,
    { a: matchedA?.roomId, b: matchedB?.roomId, cubeType: matchedA?.cubeType },
  );
  check(
    'payload มีผู้เล่นครบสองคนพร้อม Elo ของประเภทที่แข่ง',
    matchedA?.players.length === 2 && matchedA.players.every((p) => p.eloRating === BASELINE_ELO),
    matchedA?.players,
  );

  // หมายเหตุ: บนเครื่อง dev ที่เปิด ALLOW_TEST_COMPETITIVE_ROOM ไว้ ตัวที่กันคือ state ไม่ใช่ roomKind
  // (ADR-039 ข้อ 5) — ผลที่ผู้เล่นเห็นเหมือนกันคือกดเริ่มเองไม่ได้
  const startRejected = await emit(alice.socket, 'room:start', {});
  check(
    'กด room:start เองระหว่างรอ server เริ่มให้ไม่ได้ → E_INVALID_STATE',
    !startRejected.ok && startRejected.error.code === 'E_INVALID_STATE',
    startRejected,
  );

  const loadingPayload = await loading;
  check(
    'server เริ่มแมตช์ให้เองหลัง MATCHED โดยไม่มีใครกดเริ่ม',
    loadingPayload !== null && typeof loadingPayload.scramble === 'string',
    loadingPayload,
  );

  const matchedSnapshot = states.find((snapshot) => snapshot.state === 'MATCHED');
  check(
    'ห้องที่ได้เป็น competitive และไม่มีรหัสห้อง (ADR-039 ข้อ 5)',
    matchedSnapshot?.roomKind === 'competitive' && matchedSnapshot.roomCode === null,
    matchedSnapshot,
  );
  check(
    'ผ่าน state MATCHED ก่อนเข้า LOADING',
    states.map((snapshot) => snapshot.state).includes('MATCHED'),
    states.map((snapshot) => snapshot.state),
  );

  const finished = waitFor<SmokeMatchResult>(alice.socket, 'match:finished', 90_000);
  await emit(alice.socket, 'solve:ready', {});
  await emit(bob.socket, 'solve:ready', {});
  await waitFor(alice.socket, 'match:started', 30_000);
  await emit(bob.socket, 'solve:surrender', {});
  await solve(alice, loadingPayload!.scramble);
  const result = await finished;

  check('แมตช์จากคิวปรับคะแนนจริง (ratingApplied = true)', result?.ratingApplied === true, result);
  const aliceResult = result?.results.find((entry) => entry.userId === alice.userId);
  const bobResult = result?.results.find((entry) => entry.userId === bob.userId);
  check(
    'คะแนนเท่ากัน 1000 → ผู้ชนะ +16 ผู้แพ้ -16',
    aliceResult?.eloChange === 16 && bobResult?.eloChange === -16,
    { alice: aliceResult?.eloChange, bob: bobResult?.eloChange },
  );

  const match = await prisma.match.findUnique({ where: { matchId: result!.matchId! } });
  check(
    'บันทึกลง DB เป็น room_type = COMPETITIVE และไม่มี room_code',
    match?.roomType === RoomType.COMPETITIVE && match.roomCode === null,
    { type: match?.roomType, code: match?.roomCode },
  );
  const [aliceRating, bobRating] = await Promise.all([
    ratingOf(alice.userId),
    ratingOf(bob.userId),
  ]);
  check(
    'Rating ขยับถูกทั้งสองฝั่ง (1016 / 984)',
    aliceRating?.eloRating === 1016 && bobRating?.eloRating === 984,
    { alice: aliceRating?.eloRating, bob: bobRating?.eloRating },
  );

  // ---- ผลย้อนหลังสำหรับคนที่พลาด `match:finished` (กด F5 หลังรอบจบ — ADR-040 ข้อ 5)
  const finishedSnapshot = states.filter((snapshot) => snapshot.state === 'FINISHED').at(-1);
  check('snapshot ตอน FINISHED แนบ matchId มาให้', finishedSnapshot?.matchId === result!.matchId, {
    snapshot: finishedSnapshot?.matchId,
    event: result!.matchId,
  });

  const detailRes = await fetch(`${API}/matches/${result!.matchId!}`);
  const detailBody = (await detailRes.json()) as { data?: MatchDetail };
  const detail = detailBody.data;
  check('GET /matches/:matchId ตอบ 200 พร้อมข้อมูล', detailRes.status === 200 && !!detail, {
    status: detailRes.status,
  });
  check(
    'ผลย้อนหลังบอก Elo ก่อน → หลัง ตรงกับที่ event ส่งไป',
    detail?.ratingApplied === true &&
      detail.players.find((p) => p.userId === alice.userId)?.eloBefore === BASELINE_ELO &&
      detail.players.find((p) => p.userId === alice.userId)?.eloAfter === BASELINE_ELO + 16 &&
      detail.players.find((p) => p.userId === bob.userId)?.eloAfter === BASELINE_ELO - 16,
    detail?.players,
  );
  check(
    'ผลย้อนหลังเรียงตามอันดับ ผู้ชนะอยู่บนสุด',
    detail?.players[0]?.userId === alice.userId && detail.players[0]?.rankNo === 1,
    detail?.players.map((p) => ({ userId: p.userId, rankNo: p.rankNo })),
  );

  const missing = await fetch(`${API}/matches/999999999`);
  check('ขอแมตช์ที่ไม่มีอยู่ → 404', missing.status === 404, missing.status);

  await emit(alice.socket, 'room:leave', {});
  await emit(bob.socket, 'room:leave', {});

  // ---------------------------------------------------------------- 2. เคสขอบของคิว
  console.log('\nรอบที่ 2 — เคสขอบ: เข้าคิวซ้ำ · ออกจากคิว · คนละประเภท · หลุดระหว่างรอ');
  await Promise.all([setElo(alice.userId, BASELINE_ELO), setElo(bob.userId, BASELINE_ELO)]);

  const first = await joinQueue(alice);
  const again = await joinQueue(alice);
  check('เข้าคิวครั้งแรกผ่านปกติ', first.ok, first);
  check(
    'queue:join ตอนอยู่ในคิวอยู่แล้ว → E_ALREADY_IN_QUEUE',
    !again.ok && again.error.code === 'E_ALREADY_IN_QUEUE',
    again,
  );

  const status = await waitFor<{ waitedMs: number; eloWindow: number | null }>(
    alice.socket,
    'queue:status',
    8_000,
  );
  check(
    'ได้ queue:status ระหว่างรอ พร้อม waitedMs และช่วง Elo ปัจจุบัน',
    status !== null && status.waitedMs >= 5_000 && status.eloWindow === 100,
    status,
  );

  const left = await emit<{ left: boolean }>(alice.socket, 'queue:leave', {});
  const leftAgain = await emit<{ left: boolean }>(alice.socket, 'queue:leave', {});
  check('queue:leave ตอบ left = true', left.ok && left.data.left === true, left);
  check(
    'queue:leave ซ้ำตอบ left = false ไม่ใช่ error',
    leftAgain.ok && leftAgain.data.left === false,
    leftAgain,
  );

  // คนละประเภทรูบิค = คนละช่องคิว ต้องไม่เจอกัน
  const wrongCube = waitFor<Matched>(alice.socket, 'queue:matched', 4_000);
  await joinQueue(alice, '2x2x2');
  await joinQueue(bob, '3x3x3');
  check('เลือกคนละประเภทรูบิค = ไม่จับคู่กัน', (await wrongCube) === null);
  await emit(bob.socket, 'queue:leave', {});
  await emit(alice.socket, 'queue:leave', {});

  // หลุดระหว่างรอคิว = ออกจากคิวทันที คนที่เข้ามาทีหลังต้องไม่เจอที่นั่งผี
  const ghost = await openPlayer('pimchanok');
  await setElo(ghost.userId, BASELINE_ELO);
  await joinQueue(ghost);
  ghost.socket.close();
  await sleep(500);

  const noGhost = waitFor<Matched>(alice.socket, 'queue:matched', 4_000);
  await joinQueue(alice);
  check('คนที่หลุดระหว่างรอคิวถูกถอดออกจากคิวแล้ว', (await noGhost) === null);
  await emit(alice.socket, 'queue:leave', {});

  // ---------------------------------------------------------------- 3. ช่วง Elo ขยายตามเวลารอ
  console.log('\nรอบที่ 3 — คะแนนห่าง 150 แต้ม: ยังไม่จับตอนแรก แล้วจับได้เมื่อช่วงกว้างขึ้น');
  await Promise.all([setElo(alice.userId, 1_000), setElo(carol.userId, 1_150)]);

  let matchedAtTs: number | null = null;
  alice.socket.once('queue:matched', () => {
    matchedAtTs = Date.now();
  });
  const matchedLate = waitFor<Matched>(alice.socket, 'queue:matched', 20_000);
  const loadingLate = waitFor<{ scramble: string }>(alice.socket, 'match:loading', 30_000);
  const queuedAtTs = Date.now();
  await joinQueue(alice);
  await joinQueue(carol);

  await sleep(6_000);
  check('ห่าง 150 แต้มในช่วง ±100 = ยังไม่จับคู่ใน 6 วินาทีแรก', matchedAtTs === null, matchedAtTs);
  check(
    'รอครบ 10 วินาที ช่วงขยายเป็น ±200 → จับคู่ได้',
    (await matchedLate) !== null && matchedAtTs !== null && matchedAtTs - queuedAtTs >= 10_000,
    { waitedMs: matchedAtTs === null ? null : matchedAtTs - queuedAtTs },
  );

  // จบแมตช์นี้เร็ว ๆ ด้วยการยอมแพ้ทั้งคู่ (เสมอ) เพื่อไม่ให้ห้องค้างไปชน hard timeout
  const finishedLate = waitFor<SmokeMatchResult>(alice.socket, 'match:finished', 90_000);
  await loadingLate;
  await emit(alice.socket, 'solve:ready', {});
  await emit(carol.socket, 'solve:ready', {});
  await waitFor(alice.socket, 'match:started', 30_000);
  await emit(alice.socket, 'solve:surrender', {});
  await emit(carol.socket, 'solve:surrender', {});
  const lateResult = await finishedLate;
  check(
    'แมตช์ที่จับคู่ตอนช่วงกว้างขึ้นก็ปรับคะแนนตามปกติ',
    lateResult?.ratingApplied === true &&
      lateResult.results.every((entry) => entry.eloChange !== null),
    lateResult?.results,
  );

  // เข้าคิวตอนยังอยู่ในห้องที่จบแล้ว → server พาออกจากห้องให้เอง ไม่ใช่ error
  const joinFromRoom = await joinQueue(alice);
  check(
    'เข้าคิวตอนยังอยู่ในห้องที่จบแล้ว → server พาออกจากห้องให้เอง',
    joinFromRoom.ok,
    joinFromRoom,
  );
  await emit(alice.socket, 'queue:leave', {});
  await emit(carol.socket, 'room:leave', {});

  // ---------------------------------------------------------------- 4. ยุบห้องก่อนเริ่ม
  console.log('');
  console.log('รอบที่ 4 — คู่แข่งหลุดก่อนเริ่มจับเวลา → คนที่เหลือถูกส่งกลับเข้าคิวให้เอง');
  await Promise.all([setElo(alice.userId, BASELINE_ELO), setElo(bob.userId, BASELINE_ELO)]);

  const aborted = waitFor<{ reason: string }>(alice.socket, 'room:aborted', 15_000);
  const backInQueue = waitFor<{ waitedMs: number }>(alice.socket, 'queue:status', 15_000);
  const matchedAgain = waitFor<Matched>(alice.socket, 'queue:matched', 15_000);
  await joinQueue(alice);
  await joinQueue(bob);
  if ((await matchedAgain) === null) throw new Error('รอบที่ 4 จับคู่ไม่ติด');

  // ปิด socket ของคู่แข่งทิ้งระหว่าง MATCHED — ตอน server จะเริ่มให้จะพบว่าเหลือคนเดียว
  bob.socket.close();

  check('ห้องถูกยุบและแจ้ง room:aborted', (await aborted)?.reason === 'player_left', await aborted);
  check(
    'คนที่ยังต่ออยู่ถูกส่งกลับเข้าคิวให้เอง โดยไม่ต้องส่ง queue:join ใหม่ (game-rules.md ข้อ 6)',
    (await backInQueue) !== null,
    'ไม่ได้รับ queue:status หลังห้องถูกยุบ',
  );
  const stillQueued = await emit<{ left: boolean }>(alice.socket, 'queue:leave', {});
  check('อยู่ในคิวจริง (queue:leave ตอบ left = true)', stillQueued.ok && stillQueued.data.left, {
    result: stillQueued,
  });

  // ---------------------------------------------------------------- เก็บกวาด
  for (const player of [alice, bob, carol]) player.socket.close();
  const code = summary();
  await prisma.$disconnect();
  process.exit(code);
}

main().catch(async (error: unknown) => {
  console.error('\n💥 ทดสอบล้ม:', error);
  await prisma.$disconnect();
  process.exit(1);
});
