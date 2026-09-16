/**
 * คิวจับคู่อัตโนมัติ — ยิงผ่าน Socket.IO เหมือนเบราว์เซอร์จริง (เฟส 5 ก้อนที่ 2)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * รันด้วย: npm run smoke:queue      (ใช้เวลาราว 90 วินาที เพราะรอ inspection 15 วิของจริง 2 รอบ)
 *
 * ครอบ: จับคู่จาก `queue:join` จริง · ห้องที่ได้เป็น competitive ไม่มีรหัสห้อง ·
 *       เริ่มเองหลัง MATCHED โดยไม่มีใครกด `room:start` · เล่นจนจบแล้ว Elo ขยับ ·
 *       `queue:status` · เข้าคิวซ้ำ · ออกจากคิว · คนละประเภทรูบิคไม่เจอกัน ·
 *       ช่วง Elo ขยายตามเวลารอ · หลุดระหว่างรอคิว · เข้าคิวตอนยังอยู่ในห้องเดิม ·
 *       **หน้ายืนยันก่อนเข้าห้อง (`READY_CHECK`) ครบทุกทางออก** (ADR-077)
 */
import { CubeType, PrismaClient, RoomType } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import {
  API,
  autoAcceptMatches,
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
  const socket = await connect(auth.token);
  // ตั้งแต่ ADR-077 ห้องไม่ถูกสร้างจนกว่าทุกคนจะกดยืนยัน — รอบที่ทดสอบเรื่องอื่นกดให้เลย
  autoAcceptMatches(socket);
  return { ...auth, username, socket };
}

/** รอบที่ 5 คุมการกดยืนยันเอง จึงต้องปิดตัวกดอัตโนมัติก่อน */
function setAutoAccept(player: Player, on: boolean): void {
  player.socket.off('queue:match_found');
  if (on) autoAcceptMatches(player.socket);
}

/** รูปของ `queue:timeout` (socket-events.md ข้อ 4) */
interface QueueTimeout {
  waitedMs: number;
  reason: 'no_match' | 'ready_check';
}

/** รูปของ `queue:match_found` (socket-events.md ข้อ 4) */
interface MatchFound {
  kind: string;
  cubeType: string;
  rivals: { userId: number; username: string; nickname: string | null; eloRating: number }[];
  groupSize: number;
  acceptedCount: number;
  youAccepted: boolean;
  expiresAtTs: number;
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
  console.log(
    'รอบที่ 4 — คู่แข่งหลุดก่อนเริ่มจับเวลา → คนที่เหลือถูกส่งกลับเข้าคิวให้เอง (รอ grace 30 วิ)',
  );
  await Promise.all([setElo(alice.userId, BASELINE_ELO), setElo(bob.userId, BASELINE_ELO)]);

  // ตั้งแต่ ADR-077 ตัดหน่วง 2 วินาทีหลัง MATCHED ทิ้ง ห้องจึงเข้า LOADING ทันที —
  // คู่แข่งที่หลุดตอนนี้เข้าเส้นทาง grace 30 วินาทีของ `game-rules.md` ข้อ 6 แทน
  // (ยังไม่เริ่มจับเวลา → ยุบห้อง → คนที่เหลือกลับเข้าคิว) จึงต้องรอนานกว่า grace
  const aborted = waitFor<{ reason: string }>(alice.socket, 'room:aborted', 45_000);
  const backInQueue = waitFor<{ waitedMs: number }>(alice.socket, 'queue:status', 45_000);
  const matchedAgain = waitFor<Matched>(alice.socket, 'queue:matched', 15_000);
  await joinQueue(alice);
  await joinQueue(bob);
  if ((await matchedAgain) === null) throw new Error('รอบที่ 4 จับคู่ไม่ติด');

  // ปิด socket ของคู่แข่งทิ้งก่อนเริ่มจับเวลา — ครบ grace แล้ว server จะพบว่าเหลือคนเดียว
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

  // ---------------------------------------------------------------- 5. หน้ายืนยันก่อนเข้าห้อง
  console.log('');
  console.log('รอบที่ 5 — READY_CHECK: เห็นคู่แข่ง · ปฏิเสธ · หมดเวลา · หลุดระหว่างรอยืนยัน');

  // bob ถูกปิด socket ไปตั้งแต่รอบที่ 4 — เปิดใหม่แล้วคุมการกดยืนยันเองทั้งคู่
  const dave = await openPlayer('malee');
  setAutoAccept(alice, false);
  setAutoAccept(dave, false);
  await Promise.all([setElo(alice.userId, BASELINE_ELO), setElo(dave.userId, BASELINE_ELO)]);

  // ---- 5.1 เจอกลุ่มแล้วได้ queue:match_found ไม่ใช่ queue:matched
  const aliceFound = waitFor<MatchFound>(alice.socket, 'queue:match_found', 15_000);
  const daveFound = waitFor<MatchFound>(dave.socket, 'queue:match_found', 15_000);
  const noRoomYet = waitFor<Matched>(alice.socket, 'queue:matched', 6_000);
  const readyJoin = await joinQueue(alice);
  await joinQueue(dave);
  // ถ้ารอบก่อนหน้าทิ้งห้องค้างไว้ การเข้าคิวจะไม่ผ่าน แล้วรอบนี้จะล้มเป็นทอด ๆ โดยไม่รู้สาเหตุ
  check('เข้าคิวเพื่อทดสอบหน้ายืนยันได้ (ไม่มีห้องค้างจากรอบก่อน)', readyJoin.ok, readyJoin);

  const [foundA, foundD] = await Promise.all([aliceFound, daveFound]);
  check('ทั้งสองฝั่งได้ queue:match_found', foundA !== null && foundD !== null);
  check(
    'เห็นคู่ต่อสู้ครบ ชื่อ + Elo ของประเภทที่จะแข่ง และไม่มีตัวเองอยู่ในรายการ',
    foundA?.rivals.length === 1 &&
      foundA.rivals[0]?.userId === dave.userId &&
      foundA.rivals[0]?.username === dave.username &&
      foundA.rivals[0]?.eloRating === BASELINE_ELO,
    foundA?.rivals,
  );
  check(
    'payload บอกขนาดกลุ่ม · จำนวนที่ยืนยันแล้ว · และยังไม่มีใครกด',
    foundA?.groupSize === 2 && foundA.acceptedCount === 0 && foundA.youAccepted === false,
    foundA,
  );
  check(
    'ส่ง expiresAtTs เป็นเวลาสิ้นสุด ไม่ใช่จำนวนวินาที และอยู่ในราว 12 วิข้างหน้า',
    typeof foundA?.expiresAtTs === 'number' &&
      foundA.expiresAtTs - Date.now() > 8_000 &&
      foundA.expiresAtTs - Date.now() <= 13_000,
    { expiresAtTs: foundA?.expiresAtTs, inMs: (foundA?.expiresAtTs ?? 0) - Date.now() },
  );
  check('ยังไม่ได้ยืนยัน = ยังไม่มีห้อง (ไม่มี queue:matched)', (await noRoomYet) === null);

  // ---- 5.2 ยังอยู่ในคิวระหว่างรอยืนยัน — เข้าคิวซ้ำไม่ได้
  const joinWhilePending = await joinQueue(alice);
  check(
    'queue:join ระหว่างรอยืนยัน → E_ALREADY_IN_QUEUE (ยังนับว่าอยู่ในคิว)',
    !joinWhilePending.ok && joinWhilePending.error.code === 'E_ALREADY_IN_QUEUE',
    joinWhilePending,
  );

  // ---- 5.3 ฝ่ายหนึ่งยอมรับ อีกฝ่ายเห็นตัวเลขขยับ แล้วกดปฏิเสธ
  const daveSeesAccept = waitFor<MatchFound>(dave.socket, 'queue:match_found', 5_000);
  const aliceBackInQueue = waitFor<{ waitedMs: number }>(alice.socket, 'queue:status', 8_000);
  const accepted = await emit<{ accepted: number; groupSize: number }>(
    alice.socket,
    'queue:accept',
    {},
  );
  check(
    'queue:accept ตอบจำนวนที่ยืนยันแล้วกับขนาดกลุ่ม',
    accepted.ok && accepted.data.accepted === 1 && accepted.data.groupSize === 2,
    accepted,
  );
  const afterAccept = await daveSeesAccept;
  check(
    'อีกฝ่ายได้ queue:match_found ใบใหม่ที่ acceptedCount ขยับ (ใช้โชว์ 2/4 ในห้องหลายคน)',
    afterAccept?.acceptedCount === 1 && afterAccept.youAccepted === false,
    afterAccept,
  );

  const acceptAgain = await emit<{ accepted: number }>(alice.socket, 'queue:accept', {});
  check(
    'กด queue:accept ซ้ำไม่ใช่ error ตอบจำนวนเดิมกลับมา',
    acceptAgain.ok && acceptAgain.data.accepted === 1,
    acceptAgain,
  );

  const declined = await emit<{ left: boolean }>(dave.socket, 'queue:decline', {});
  check(
    'queue:decline ตอบ left = true (ออกจากคิวจริง)',
    declined.ok && declined.data.left,
    declined,
  );
  check(
    'คนที่กดยอมรับได้ queue:status = server พากลับเข้าคิวให้เองโดยไม่ต้องกดอะไร',
    (await aliceBackInQueue) !== null,
    'ไม่ได้รับ queue:status หลังอีกฝ่ายปฏิเสธ',
  );

  const aliceStill = await emit<{ left: boolean }>(alice.socket, 'queue:leave', {});
  const daveGone = await emit<{ left: boolean }>(dave.socket, 'queue:leave', {});
  check('คนที่ยอมรับยังอยู่ในคิว', aliceStill.ok && aliceStill.data.left === true, aliceStill);
  check('คนที่ปฏิเสธออกจากคิวไปแล้ว', daveGone.ok && daveGone.data.left === false, daveGone);

  const acceptOutside = await emit(alice.socket, 'queue:accept', {});
  check(
    'queue:accept ตอนไม่ได้อยู่ใน READY_CHECK → E_INVALID_STATE',
    !acceptOutside.ok && acceptOutside.error.code === 'E_INVALID_STATE',
    acceptOutside,
  );

  // ---- 5.4 ปล่อยหมดเวลา = ปฏิเสธทั้งคู่
  const bothFound = Promise.all([
    waitFor<MatchFound>(alice.socket, 'queue:match_found', 15_000),
    waitFor<MatchFound>(dave.socket, 'queue:match_found', 15_000),
  ]);
  await joinQueue(alice);
  await joinQueue(dave);
  const pair = await bothFound;
  check(
    'จับกันใหม่ได้ทันที — คู่ที่ปฏิเสธไม่นับว่าเคยเจอกัน',
    pair.every((p) => p !== null),
  );

  // 🔴 คนที่ปล่อยหมดเวลาไม่มี ack ให้ยึดเหมือนตอนกดยกเลิกเอง — ถ้า server ไม่ยิงอะไรกลับมา
  // หน้ายืนยันบนจอจะค้างตลอดไป (บั๊กที่เจ้าของเจอตอนลองด้วยมือ)
  const [timeoutA, timeoutD] = await Promise.all([
    waitFor<QueueTimeout>(alice.socket, 'queue:timeout', 16_000),
    waitFor<QueueTimeout>(dave.socket, 'queue:timeout', 16_000),
  ]);
  check(
    'ปล่อยหมดเวลา → ทั้งคู่ได้ queue:timeout กลับมา (จอต้องไม่ค้างที่หน้ายืนยัน)',
    timeoutA !== null && timeoutD !== null,
    { alice: timeoutA, dave: timeoutD },
  );
  check(
    'queue:timeout บอก reason = ready_check แยกจากการรอครบ 180 วิ',
    timeoutA?.reason === 'ready_check' && timeoutD?.reason === 'ready_check',
    { alice: timeoutA?.reason, dave: timeoutD?.reason },
  );

  const aliceTimedOut = await emit<{ left: boolean }>(alice.socket, 'queue:leave', {});
  const daveTimedOut = await emit<{ left: boolean }>(dave.socket, 'queue:leave', {});
  check(
    'ไม่มีใครกดยืนยันจนหมดเวลา → ทั้งคู่หลุดจากคิว (หมดเวลา = ปฏิเสธ)',
    aliceTimedOut.ok &&
      aliceTimedOut.data.left === false &&
      daveTimedOut.ok &&
      daveTimedOut.data.left === false,
    { alice: aliceTimedOut, dave: daveTimedOut },
  );

  // ---- 5.5 คนที่ยอมรับแล้วปล่อยอีกฝ่ายหมดเวลา — ต้องอยู่ในคิวต่อ
  const foundAgain = Promise.all([
    waitFor<MatchFound>(alice.socket, 'queue:match_found', 15_000),
    waitFor<MatchFound>(dave.socket, 'queue:match_found', 15_000),
  ]);
  await joinQueue(alice);
  await joinQueue(dave);
  if ((await foundAgain).some((p) => p === null)) throw new Error('รอบที่ 5.5 จับคู่ไม่ติด');

  const aliceRequeued = waitFor<{ waitedMs: number }>(alice.socket, 'queue:status', 20_000);
  const daveToldAlone = waitFor<QueueTimeout>(dave.socket, 'queue:timeout', 20_000);
  // คนที่กดยอมรับต้องไม่โดนเตะออกจากคิวไปด้วย จึงต้องไม่ได้ queue:timeout
  const aliceNotTimedOut = waitFor<QueueTimeout>(alice.socket, 'queue:timeout', 16_000);
  await emit(alice.socket, 'queue:accept', {});
  check(
    'คนที่ยอมรับแล้วอีกฝ่ายปล่อยหมดเวลา → ได้ queue:status กลับมา',
    (await aliceRequeued) !== null,
    'ไม่ได้รับ queue:status หลังอีกฝ่ายหมดเวลา',
  );
  check(
    'ฝ่ายที่ไม่กดอะไรเลยได้ queue:timeout รู้ตัวว่าหลุดเพราะไม่ได้ยืนยัน',
    (await daveToldAlone)?.reason === 'ready_check',
    await daveToldAlone,
  );
  check(
    'ฝ่ายที่กดยอมรับไม่ได้ queue:timeout (ยังอยู่ในคิวต่อ)',
    (await aliceNotTimedOut) === null,
    await aliceNotTimedOut,
  );
  const aliceKept = await emit<{ left: boolean }>(alice.socket, 'queue:leave', {});
  const daveDropped = await emit<{ left: boolean }>(dave.socket, 'queue:leave', {});
  check('คนที่ยอมรับยังอยู่ในคิว', aliceKept.ok && aliceKept.data.left === true, aliceKept);
  check(
    'คนที่ไม่กดอะไรเลยหลุดจากคิว',
    daveDropped.ok && daveDropped.data.left === false,
    daveDropped,
  );

  // ---- 5.6 คนอื่นกดยกเลิกก่อนที่เราจะทันได้กด — เราต้องไม่ถูกถอดออกจากคิวไปด้วย
  const bothSee = Promise.all([
    waitFor<MatchFound>(alice.socket, 'queue:match_found', 15_000),
    waitFor<MatchFound>(dave.socket, 'queue:match_found', 15_000),
  ]);
  await joinQueue(alice);
  await joinQueue(dave);
  if ((await bothSee).some((p) => p === null)) throw new Error('รอบที่ 5.6 จับคู่ไม่ติด');

  const aliceUntouched = waitFor<{ waitedMs: number }>(alice.socket, 'queue:status', 8_000);
  // dave กดยกเลิกทันที ตอนที่ alice ยังไม่ได้กดอะไรและยังไม่ได้ใช้ 12 วินาทีของตัวเองเลย
  await emit(dave.socket, 'queue:decline', {});
  check(
    'อีกฝ่ายกดยกเลิกก่อนเราทันได้กด → ได้ queue:status กลับมา',
    (await aliceUntouched) !== null,
    'ไม่ได้รับ queue:status หลังอีกฝ่ายกดยกเลิก',
  );
  const notPunished = await emit<{ left: boolean }>(alice.socket, 'queue:leave', {});
  check(
    'คนที่ยังไม่ทันได้กดยังอยู่ในคิว — "หมดเวลา = ปฏิเสธ" ใช้กับการหมดเวลาจริงเท่านั้น',
    notPunished.ok && notPunished.data.left === true,
    notPunished,
  );
  await emit(dave.socket, 'queue:leave', {});

  // ---- 5.7 หลุดระหว่างรอยืนยัน = ปฏิเสธ อีกฝ่ายต้องไม่ค้าง
  const ghostFound = waitFor<MatchFound>(dave.socket, 'queue:match_found', 15_000);
  const aliceFoundAgain = waitFor<MatchFound>(alice.socket, 'queue:match_found', 15_000);
  await joinQueue(alice);
  await joinQueue(dave);
  if ((await ghostFound) === null || (await aliceFoundAgain) === null) {
    throw new Error('รอบที่ 5.7 จับคู่ไม่ติด');
  }

  const aliceAfterDrop = waitFor<{ waitedMs: number }>(alice.socket, 'queue:status', 8_000);
  await emit(alice.socket, 'queue:accept', {});
  dave.socket.close();
  check(
    'อีกฝ่ายปิดแท็บระหว่างรอยืนยัน → กลับเข้าคิวทันที ไม่ต้องรอจนหมด 12 วินาที',
    (await aliceAfterDrop) !== null,
    'ไม่ได้รับ queue:status หลังคู่แข่งหลุด',
  );
  await emit(alice.socket, 'queue:leave', {});

  // ---------------------------------------------------------------- เก็บกวาด
  for (const player of [alice, bob, carol, dave]) player.socket.close();
  const code = summary();
  await prisma.$disconnect();
  process.exit(code);
}

main().catch(async (error: unknown) => {
  console.error('\n💥 ทดสอบล้ม:', error);
  await prisma.$disconnect();
  process.exit(1);
});
