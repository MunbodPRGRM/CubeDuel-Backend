/**
 * ห้อง **ผู้เล่นหลายคน** ครบวงจรผ่าน Socket.IO — คิว auto 3–4 คน · ห้องสร้างเอง · Pairwise Elo
 * (เฟส 6 ก้อนที่ 1 + ก้อนที่ 2)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * **ไม่ต้องใช้ `ALLOW_TEST_COMPETITIVE_ROOM` แล้ว** — ทางเข้าห้องหลายคนเปิดให้ผู้ใช้จริงตั้งแต่
 * ก้อนที่ 2 (ADR-043 ข้อ 5) สโมคเทสจึงเดินสายเดียวกับเบราว์เซอร์ทุกขั้นตอน
 * รันด้วย: npm run smoke:multi     (ใช้เวลาราว 2 นาทีครึ่ง เพราะรอ inspection 15 วิจริง 4 รอบ
 *                                   และรอกติกา "60 วินาทีแล้วเริ่มด้วย 3 คน" ของจริงอีก 1 นาที)
 *
 * ครอบ: จับกลุ่ม 4 คนจาก `queue:join` จริง · คนที่ 4 เข้ามาตอนกำลังรอ · กติกา 60 วิ/3 คน ·
 *       คิวหลายคนแยกช่องจากคิว 1v1 · Pairwise Elo + แถว `MultiplayerMatch` + participant ·
 *       `Rating` ของทุกคน · `MatchFlag` ผูกกับ `multiplayer_match_id` และไม่มี `WIN_STREAK` ·
 *       `opponent:move` / `opponent:progress` กระจายถูกเมื่อมีผู้เล่นเกิน 2 คน ·
 *       ห้องสร้างเอง 3 คน (โหมด custom ไม่ปรับคะแนน) · ปิดผู้ชม · `E_ROOM_FULL` ·
 *       DNF ทั้งห้องต้องไม่พังตอนบันทึก (ADR-041 ข้อ 3)
 */
import { CubeType, PrismaClient, RoomMode, SolveResult } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import {
  API,
  check,
  connect,
  emit,
  login,
  sendMoves,
  solutionMoves,
  startRound,
  summary,
  waitFor,
  type SmokeMatchResult,
} from './smoke-helpers.js';

const CUBE_TYPE = '2x2x2';
const PRISMA_CUBE_TYPE = CubeType.CUBE_2X2X2;
/** คะแนนตั้งต้นที่บังคับไว้ก่อนเริ่ม เพื่อให้ตัวเลขที่คาดหวังคงที่ทุกครั้งที่รัน */
const BASELINE_ELO = 1000;

const prisma = new PrismaClient();

interface Player {
  name: string;
  userId: number;
  socket: Socket;
}

interface Matched {
  roomId: number;
  cubeType: string;
  players: { userId: number; username: string }[];
}

interface Snapshot {
  roomId: number;
  roomKind: string;
  roomMode: string | null;
  roomCode: string | null;
  state: string;
  maxPlayers: number;
  matchId: number | null;
  matchKind: '1v1' | 'multiplayer' | null;
}

/** รูปของ `GET /multiplayer-matches/:multiplayerMatchId` (api-contract.md ข้อ 3) */
interface MultiplayerMatchDetail {
  multiplayerMatchId: number;
  roomMode: 'auto' | 'custom';
  playerCount: number;
  winnerId: number | null;
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

function ratingOf(userId: number) {
  return prisma.rating.findUnique({
    where: { userId_cubeType: { userId, cubeType: PRISMA_CUBE_TYPE } },
  });
}

async function setElo(userId: number, elo: number): Promise<void> {
  await prisma.rating.update({
    where: { userId_cubeType: { userId, cubeType: PRISMA_CUBE_TYPE } },
    data: { eloRating: elo },
  });
}

function ratingSnapshot(players: Player[]) {
  return Promise.all(
    players.map(async (player) => [player.userId, (await ratingOf(player.userId))!] as const),
  ).then((entries) => new Map(entries));
}

function joinQueue(player: Player, kind: 'competitive' | 'multiplayer' = 'multiplayer') {
  return emit<{ queuedAtTs: number; playersInQueue: number }>(player.socket, 'queue:join', {
    cubeType: CUBE_TYPE,
    kind,
  });
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

/**
 * ห้องที่มาจากคิว **ไม่มีใครกดเริ่ม** — server เริ่มให้เองหลัง `MATCHED`
 * ผู้เรียกต้องดัก `match:loading` ไว้ก่อนเข้าคิว แล้วส่ง promise นั้นเข้ามา
 */
async function readyUpQueuedRound(
  players: Player[],
  loading: Promise<{ scramble: string } | null>,
): Promise<string> {
  const payload = await loading;
  if (!payload) throw new Error('ไม่ได้รับ match:loading ของห้องที่จับกลุ่มได้');
  for (const player of players) await emit(player.socket, 'solve:ready', {});
  await waitFor(players[0]!.socket, 'match:started', 40_000);
  return payload.scramble;
}

/**
 * แก้คิวบ์ให้เสร็จจริง — `gapMs = 0` คือหมุนรัวจนติดเกณฑ์ soft ของ anti-cheat
 * (ใช้จงใจเพื่อดูว่า `MatchFlag` ของห้องหลายคนถูกผูกกับคอลัมน์ไหน)
 */
async function solve(player: Player, scramble: string, gapMs: number): Promise<void> {
  const moves = solutionMoves(scramble);
  await sendMoves(player.socket, moves, gapMs);
  const solved = await emit(player.socket, 'solve:solved', {
    seq: moves.length,
    moveCount: moves.length,
    clientTs: Date.now(),
  });
  if (!solved.ok) throw new Error(`${player.name} แจ้งแก้เสร็จไม่ผ่าน: ${solved.error.code}`);
}

/** ทุกคนยอมแพ้ = จบรอบเร็ว ๆ โดยไม่ต้องรอ hard timeout */
async function surrenderAll(players: Player[]): Promise<void> {
  for (const player of players) await emit(player.socket, 'solve:surrender', {});
}

async function leaveRoomAll(players: Player[]): Promise<void> {
  for (const player of players) await emit(player.socket, 'room:leave', {});
}

async function main(): Promise<void> {
  console.log(`\n👥 ทดสอบห้องผู้เล่นหลายคน — คิว auto + ห้องสร้างเอง (${CUBE_TYPE})\n`);

  const names = ['somchai', 'malee', 'nattapong', 'pimchanok', 'thanawat'];
  const players: Player[] = [];
  for (const name of names) {
    const auth = await login(name);
    players.push({ name, ...auth, socket: await connect(auth.token) });
  }
  const [alice, bob, chai, dao, eve] = players as [Player, Player, Player, Player, Player];
  const quartet = [alice, bob, chai, dao];

  // เริ่มจากคะแนนเท่ากันทุกคน ตัวเลขที่คาดหวังจะได้ไม่ขึ้นกับผลรันครั้งก่อน
  await Promise.all(players.map((player) => setElo(player.userId, BASELINE_ELO)));
  const before = await ratingSnapshot(quartet);

  // ---------------------------------------------------------------- รอบที่ 1
  console.log('รอบที่ 1 — คิว auto: 3 คนรออยู่ก่อน คนที่ 4 เข้ามาแล้วจับกลุ่มทันที');

  const states = recordStates(alice.socket);
  const matchedEvents = quartet.map((player) =>
    waitFor<Matched>(player.socket, 'queue:matched', 30_000),
  );
  const loading1 = waitFor<{ scramble: string }>(alice.socket, 'match:loading', 30_000);

  const joins = [];
  for (const player of [alice, bob, chai]) joins.push(await joinQueue(player));
  check(
    'queue:join ที่ kind = multiplayer ผ่านแล้ว (เดิมตอบ E_VALIDATION)',
    joins.every((ack) => ack.ok),
    joins,
  );
  check(
    'คนที่สามเห็นว่ามี 3 คนในช่องคิวเดียวกัน',
    joins[2]?.ok === true && joins[2].data.playersInQueue === 3,
    joins[2],
  );

  const tooSoon = await waitFor<Matched>(alice.socket, 'queue:matched', 6_000);
  check('มี 3 คนแต่ยังรอไม่ถึง 60 วินาที = ยังไม่จับกลุ่ม', tooSoon === null, tooSoon);

  const againInQueue = await joinQueue(alice);
  check(
    'queue:join ซ้ำในคิวหลายคน → E_ALREADY_IN_QUEUE',
    !againInQueue.ok && againInQueue.error.code === 'E_ALREADY_IN_QUEUE',
    againInQueue,
  );

  await joinQueue(dao);
  const matched = await Promise.all(matchedEvents);
  check('คนที่ 4 เข้ามาแล้วทั้งสี่คนได้ queue:matched ทันที', matched.every((m) => m !== null));
  check(
    'ทุกคนได้ห้องเดียวกันและ payload มีผู้เล่นครบ 4 คน',
    new Set(matched.map((m) => m?.roomId)).size === 1 && matched[0]?.players.length === 4,
    matched.map((m) => [m?.roomId, m?.players.length]),
  );

  const matchedSnapshot = states.find((snapshot) => snapshot.state === 'MATCHED');
  check(
    'ห้องที่ได้เป็น multiplayer โหมด auto ไม่มีรหัสห้อง (ADR-043 ข้อ 4)',
    matchedSnapshot?.roomKind === 'multiplayer' &&
      matchedSnapshot.roomMode === 'auto' &&
      matchedSnapshot.roomCode === null &&
      matchedSnapshot.maxPlayers === 4,
    matchedSnapshot,
  );

  const startRejected = await emit(alice.socket, 'room:start', {});
  check(
    'ห้องจากคิวกดเริ่มเองไม่ได้ → E_INVALID_STATE',
    !startRejected.ok && startRejected.error.code === 'E_INVALID_STATE',
    startRejected,
  );

  // ผู้เล่นคนที่ไม่ได้แก้ต้องเห็นการหมุนของ "ทุกคน" ไม่ใช่แค่คนเดียวแบบห้อง 1v1
  const movesSeenBy = new Set<number>();
  const progressSeenBy = new Set<number>();
  dao.socket.on('opponent:move', (payload: { userId: number }) => movesSeenBy.add(payload.userId));
  dao.socket.on('opponent:progress', (payload: { userId: number }) =>
    progressSeenBy.add(payload.userId),
  );

  const finished1 = waitFor<SmokeMatchResult>(alice.socket, 'match:finished', 120_000);
  const scramble1 = await readyUpQueuedRound(quartet, loading1);

  // Alice หมุนรัว → เร็วจนติดเกณฑ์ soft (ไว้ตรวจว่า MatchFlag ผูกกับแมตช์หลายคนได้)
  await solve(alice, scramble1, 0);
  await emit(chai.socket, 'solve:surrender', {});
  await emit(dao.socket, 'solve:surrender', {});
  // Bob แก้เสร็จทีหลังในช่วงนับถอยหลัง 10 วินาที → อันดับ 2
  await solve(bob, scramble1, 60);
  const result1 = await finished1;

  check('ได้รับ match:finished ของห้องหลายคน', result1 !== null, result1);
  check('roomKind = multiplayer', result1?.roomKind === 'multiplayer', result1?.roomKind);
  check('โหมด auto ปรับคะแนนจริง (ratingApplied = true)', result1?.ratingApplied === true);
  check(
    'match:finished แนบ matchId ของแมตช์หลายคนพร้อม matchKind กำกับ (ADR-044 ข้อ 1)',
    typeof result1?.matchId === 'number' && result1.matchKind === 'multiplayer',
    [result1?.matchId, result1?.matchKind],
  );
  check(
    'opponent:move กระจายถึงผู้เล่นคนอื่นครบทุกคนที่หมุน (ไม่ใช่แค่คู่เดียวแบบ 1v1)',
    movesSeenBy.has(alice.userId) && movesSeenBy.has(bob.userId) && !movesSeenBy.has(dao.userId),
    [...movesSeenBy],
  );
  check(
    'opponent:progress ของคนที่ยังแก้อยู่ส่งถึงคนที่ยอมแพ้ไปแล้วด้วย',
    progressSeenBy.has(bob.userId),
    [...progressSeenBy],
  );

  const rank = (userId: number) => result1?.results.find((entry) => entry.userId === userId);
  check(
    'อันดับเรียงตามเวลา แล้วคนที่ยอมแพ้ได้อันดับท้ายเท่ากัน (1, 2, 3, 3)',
    rank(alice.userId)?.rankNo === 1 &&
      rank(bob.userId)?.rankNo === 2 &&
      rank(chai.userId)?.rankNo === 3 &&
      rank(dao.userId)?.rankNo === 3,
    result1?.results.map((entry) => [entry.username, entry.rankNo]),
  );
  check(
    'Pairwise Elo: คะแนนเท่ากันหมด อันดับ 1/2/3/3 → +16 / +6 / -11 / -11',
    rank(alice.userId)?.eloChange === 16 &&
      rank(bob.userId)?.eloChange === 6 &&
      rank(chai.userId)?.eloChange === -11 &&
      rank(dao.userId)?.eloChange === -11,
    result1?.results.map((entry) => [entry.username, entry.eloChange]),
  );
  check(
    'ผลรวม elo_change ของทั้งห้องเป็นศูนย์',
    (result1?.results ?? []).reduce((total, entry) => total + (entry.eloChange ?? 0), 0) === 0,
  );

  const multi1 = await prisma.multiplayerMatch.findFirst({
    orderBy: { multiplayerMatchId: 'desc' },
    include: { participants: true },
  });
  check('บันทึกลงตาราง MultiplayerMatch (ไม่ใช่ Match)', multi1 !== null);
  check('room_mode = AUTO', multi1?.roomMode === RoomMode.AUTO, multi1?.roomMode);
  check('player_count = 4', multi1?.playerCount === 4, multi1?.playerCount);
  check(
    'ห้องจากคิวไม่มีรหัสห้องให้เก็บ',
    multi1?.roomCode === null,
    multi1?.roomCode,
  );
  check('finished_at ถูกบันทึก', multi1?.finishedAt !== null);
  check('participant ครบ 4 แถว', multi1?.participants.length === 4, multi1?.participants.length);

  const part = (userId: number) => multi1?.participants.find((row) => row.userId === userId);
  check(
    'participant: ผู้ที่ยอมแพ้บันทึก SURRENDERED และเวลาเป็น NULL (ห้ามใช้ 0 แทน)',
    part(chai.userId)?.result === SolveResult.SURRENDERED &&
      part(chai.userId)?.solveTime === null &&
      part(dao.userId)?.result === SolveResult.SURRENDERED,
    multi1?.participants.map((row) => [row.userId, row.result, row.solveTime?.toString()]),
  );
  check(
    'participant: คนที่แก้เสร็จมีเวลาและ move_count',
    part(alice.userId)?.result === SolveResult.SOLVED &&
      part(alice.userId)?.solveTime !== null &&
      (part(alice.userId)?.moveCount ?? 0) > 0,
    [part(alice.userId)?.solveTime?.toString(), part(alice.userId)?.moveCount],
  );
  check(
    'participant: elo_before / elo_change ครบทุกแถวและตรงกับที่ส่งให้ client',
    multi1?.participants.every(
      (row) => row.eloBefore === BASELINE_ELO && row.eloChange === rank(row.userId)?.eloChange,
    ) === true,
    multi1?.participants.map((row) => [row.userId, row.eloBefore, row.eloChange]),
  );
  check(
    'participant: rank_no ตรงกับที่ส่งให้ client',
    multi1?.participants.every((row) => row.rankNo === rank(row.userId)?.rankNo) === true,
    multi1?.participants.map((row) => [row.userId, row.rankNo]),
  );

  // ---------------------------------------------------------------- อ่านผลย้อนหลัง (ADR-044 ข้อ 1)

  check(
    'matchId ที่ส่งให้ client คือ multiplayer_match_id จริง ไม่ใช่ match_id',
    result1?.matchId === multi1?.multiplayerMatchId,
    [result1?.matchId, multi1?.multiplayerMatchId],
  );

  const finishedSnapshot = states.filter((snapshot) => snapshot.state === 'FINISHED').at(-1);
  check(
    'snapshot ตอน FINISHED แนบ matchId + matchKind ชุดเดียวกับ match:finished (กด F5 แล้วผลยังอยู่)',
    finishedSnapshot?.matchId === result1?.matchId &&
      finishedSnapshot?.matchKind === 'multiplayer',
    [finishedSnapshot?.matchId, finishedSnapshot?.matchKind],
  );

  const multiRes = await fetch(`${API}/multiplayer-matches/${result1!.matchId!}`);
  const multiDetail = ((await multiRes.json()) as { data?: MultiplayerMatchDetail }).data ?? null;
  check(
    'GET /multiplayer-matches/:id ตอบ 200 พร้อมข้อมูลของแมตช์ที่เพิ่งจบ',
    multiRes.status === 200 && multiDetail?.multiplayerMatchId === result1!.matchId,
    [multiRes.status, multiDetail?.multiplayerMatchId],
  );
  check(
    'REST คืน roomMode / playerCount / ratingApplied ของโหมด auto',
    multiDetail?.roomMode === 'auto' &&
      multiDetail.playerCount === 4 &&
      multiDetail.ratingApplied === true,
    [multiDetail?.roomMode, multiDetail?.playerCount, multiDetail?.ratingApplied],
  );
  check(
    'REST เรียงตาม rankNo และ Elo ก่อน→หลัง ตรงกับ match:finished ทุกแถว',
    multiDetail?.players.length === 4 &&
      multiDetail.players.every((row, index) => index === 0 || row.rankNo >= multiDetail.players[index - 1]!.rankNo) &&
      multiDetail.players.every(
        (row) =>
          row.eloBefore === BASELINE_ELO &&
          row.eloChange === rank(row.userId)?.eloChange &&
          row.eloAfter === rank(row.userId)?.eloAfter,
      ),
    multiDetail?.players.map((row) => [row.userId, row.rankNo, row.eloBefore, row.eloAfter]),
  );
  check(
    'REST คืน winnerId = คนที่ได้อันดับ 1 คนเดียวและแก้เสร็จจริง',
    multiDetail?.winnerId === alice.userId,
    multiDetail?.winnerId,
  );

  const missing = await fetch(`${API}/multiplayer-matches/999999999`);
  check('ไม่พบแมตช์หลายคน → 404', missing.status === 404, missing.status);

  const after1 = await ratingSnapshot(quartet);
  check(
    'Rating: elo ของทุกคนขยับตาม elo_change ในทรานแซกชันเดียวกัน',
    after1.get(alice.userId)!.eloRating === 1016 &&
      after1.get(bob.userId)!.eloRating === 1006 &&
      after1.get(chai.userId)!.eloRating === 989 &&
      after1.get(dao.userId)!.eloRating === 989,
    quartet.map((player) => [player.name, after1.get(player.userId)!.eloRating]),
  );
  check(
    'Rating: ผู้ชนะได้ wins +1 · ที่เหลือได้ losses +1 (นับเหมือน 1v1 — ADR-041 ข้อ 1)',
    after1.get(alice.userId)!.wins === before.get(alice.userId)!.wins + 1 &&
      after1.get(bob.userId)!.losses === before.get(bob.userId)!.losses + 1 &&
      after1.get(chai.userId)!.losses === before.get(chai.userId)!.losses + 1 &&
      after1.get(dao.userId)!.losses === before.get(dao.userId)!.losses + 1,
    quartet.map((player) => [
      player.name,
      after1.get(player.userId)!.wins,
      after1.get(player.userId)!.losses,
    ]),
  );
  check(
    'Rating: matches_played +1 ทุกคน',
    quartet.every(
      (player) =>
        after1.get(player.userId)!.matchesPlayed === before.get(player.userId)!.matchesPlayed + 1,
    ),
  );
  check(
    'Rating: best_time ของคนที่แก้เสร็จถูกอัปเดต',
    after1.get(alice.userId)!.bestTime !== null,
    after1.get(alice.userId)!.bestTime?.toString(),
  );

  const flags1 = await prisma.matchFlag.findMany({
    where: { multiplayerMatchId: multi1!.multiplayerMatchId },
  });
  check(
    'MatchFlag ของแมตช์หลายคนผูกกับ multiplayer_match_id (match_id เป็น NULL)',
    flags1.length > 0 && flags1.every((flag) => flag.matchId === null),
    flags1.map((flag) => [flag.flagReason, flag.matchId, flag.multiplayerMatchId]),
  );
  check(
    'หมุนรัวจนเร็วผิดปกติ → ติดเกณฑ์ soft ของคนที่หมุน',
    flags1.some((flag) => flag.userId === alice.userId),
    flags1.map((flag) => [flag.userId, flag.flagReason]),
  );
  check(
    'ไม่มี WIN_STREAK ในห้องหลายคน (ADR-041 ข้อ 2)',
    flags1.every((flag) => flag.flagReason !== 'WIN_STREAK'),
    flags1.map((flag) => flag.flagReason),
  );

  dao.socket.removeAllListeners('opponent:move');
  dao.socket.removeAllListeners('opponent:progress');
  alice.socket.removeAllListeners('room:state');
  await leaveRoomAll(quartet);

  // ---------------------------------------------------------------- รอบที่ 2
  console.log('\nรอบที่ 2 — คิวหลายคนแยกช่องจากคิว 1v1 (ต้องไม่ดูดกันข้ามช่อง)');
  const crossSlot = waitFor<Matched>(eve.socket, 'queue:matched', 5_000);
  await joinQueue(eve, 'competitive');
  const aliceQueuedAtTs = Date.now();
  const trioJoin = await joinQueue(alice);
  check(
    'คนในคิว 1v1 ไม่ถูกนับรวมกับช่องคิวหลายคน',
    trioJoin.ok && trioJoin.data.playersInQueue === 1,
    trioJoin,
  );
  check('คนละ kind = ไม่มีวันจับกลุ่มกัน', (await crossSlot) === null);
  await emit(eve.socket, 'queue:leave', {});

  // ---------------------------------------------------------------- รอบที่ 3
  console.log('\nรอบที่ 3 — คิว auto: มีแค่ 3 คน รอครบ 60 วินาทีแล้วเริ่มด้วย 3 คน');
  const trio = [alice, bob, chai];
  // ตั้งคะแนนกลับให้เท่ากันก่อน — เสมอทั้งห้องจะได้ 0 แต้มก็ต่อเมื่อคะแนนตั้งต้นเท่ากัน
  await Promise.all(trio.map((player) => setElo(player.userId, BASELINE_ELO)));
  const beforeTrio = await ratingSnapshot(trio);
  const trioStates = recordStates(alice.socket);
  const trioMatched = waitFor<Matched>(alice.socket, 'queue:matched', 90_000);
  const loading3 = waitFor<{ scramble: string }>(alice.socket, 'match:loading', 100_000);
  for (const player of [bob, chai]) await joinQueue(player);

  const matched3 = await trioMatched;
  // นับจากตอน alice เข้าคิว (หัวคิว) เพราะกติกา 60 วิดูคนที่รอนานที่สุด
  const waitedMs = Date.now() - aliceQueuedAtTs;
  check('รอครบ 60 วินาทีแล้วจับกลุ่มให้ 3 คน', matched3 !== null && matched3.players.length === 3, {
    players: matched3?.players.length,
    waitedMs,
  });
  check('ไม่ได้จับกลุ่มก่อนหัวคิวรอครบ 60 วินาที', waitedMs >= 60_000, { waitedMs });

  // `queue:matched` ถูกส่งก่อน `room:state` เสมอ — รอให้ snapshot ตามมาถึงก่อนค่อยอ่าน
  await sleep(500);
  const trioSnapshot = trioStates.find((snapshot) => snapshot.state === 'MATCHED');
  check(
    'ห้อง 3 คนจากคิวเป็นโหมด auto และ maxPlayers = 3',
    trioSnapshot?.roomMode === 'auto' && trioSnapshot.maxPlayers === 3,
    trioSnapshot,
  );

  const finished3 = waitFor<SmokeMatchResult>(alice.socket, 'match:finished', 120_000);
  await readyUpQueuedRound(trio, loading3);
  await surrenderAll(trio);
  const result3 = await finished3;

  check('DNF ทั้งห้องแล้วยังบันทึกผลได้ ไม่พัง (ADR-041 ข้อ 3)', result3 !== null);
  check(
    'ห้อง auto ที่คะแนนเท่ากันแล้วเสมอทั้งห้อง → ทุกคนได้อันดับ 1 และ Elo ขยับ 0 แต้ม',
    result3?.results.every((entry) => entry.rankNo === 1 && entry.eloChange === 0) === true,
    result3?.results.map((entry) => [entry.username, entry.rankNo, entry.eloChange]),
  );

  const multi3 = await prisma.multiplayerMatch.findFirst({
    orderBy: { multiplayerMatchId: 'desc' },
    include: { participants: true },
  });
  check('player_count = 3 ตามจำนวนคนที่คิวจับมาได้จริง', multi3?.playerCount === 3, multi3?.playerCount);
  check('room_mode = AUTO', multi3?.roomMode === RoomMode.AUTO, multi3?.roomMode);
  check(
    'ไม่มีผู้ชนะเมื่อ DNF ทั้งห้อง — ทุก participant ได้อันดับ 1 และเป็น SURRENDERED',
    multi3?.participants.every(
      (row) => row.rankNo === 1 && row.result === SolveResult.SURRENDERED,
    ) === true,
    multi3?.participants.map((row) => [row.userId, row.rankNo, row.result]),
  );

  const after3 = await ratingSnapshot(trio);
  check(
    'Rating: เสมอทั้งห้อง → draws +1 ทุกคน และ elo ไม่ขยับ',
    trio.every(
      (player) =>
        after3.get(player.userId)!.draws === beforeTrio.get(player.userId)!.draws + 1 &&
        after3.get(player.userId)!.eloRating === BASELINE_ELO,
    ),
    trio.map((player) => [
      player.name,
      after3.get(player.userId)!.draws,
      after3.get(player.userId)!.eloRating,
    ]),
  );

  alice.socket.removeAllListeners('room:state');
  await leaveRoomAll(trio);

  // ---------------------------------------------------------------- รอบที่ 4
  console.log('\nรอบที่ 4 — ห้องสร้างเอง 3 คน: โหมด custom ไม่ปรับคะแนน · ปิดผู้ชม · ห้องเต็ม');
  const created = await emit<{ roomId: number; roomCode: string }>(alice.socket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'multiplayer',
    maxPlayers: 3,
  });
  check(
    'room:create ที่ kind = multiplayer เปิดให้ผู้ใช้จริงแล้ว (ไม่ต้องมีสวิตช์ทดสอบ)',
    created.ok,
    created,
  );
  if (!created.ok) throw new Error('สร้างห้องหลายคนไม่ได้');
  const roomCode = created.data.roomCode;

  const badSize = await emit(eve.socket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'multiplayer',
    maxPlayers: 2,
  });
  check(
    'ห้องหลายคนที่ขอ 2 คน → E_VALIDATION (kind กับ maxPlayers ต้องเข้าคู่กัน)',
    !badSize.ok && badSize.error.code === 'E_VALIDATION',
    badSize,
  );

  await emit(bob.socket, 'room:join', { roomCode, as: 'player' });
  const startEarly = await emit(alice.socket, 'room:start', {});
  check(
    'host กดเริ่มตอนคนยังไม่ครบ → E_INVALID_STATE (game-rules.md ข้อ 9)',
    !startEarly.ok && startEarly.error.code === 'E_INVALID_STATE',
    startEarly,
  );

  const asSpectator = await emit(eve.socket, 'room:join', { roomCode, as: 'spectator' });
  check(
    'ห้องผู้เล่นหลายคนไม่รองรับผู้ชม → E_INVALID_STATE (game-rules.md ข้อ 9)',
    !asSpectator.ok && asSpectator.error.code === 'E_INVALID_STATE',
    asSpectator,
  );

  await emit(chai.socket, 'room:join', { roomCode, as: 'player' });
  const roomFull = await emit(eve.socket, 'room:join', { roomCode, as: 'player' });
  check(
    'เข้าห้องที่ผู้เล่นครบแล้ว → E_ROOM_FULL',
    !roomFull.ok && roomFull.error.code === 'E_ROOM_FULL',
    roomFull,
  );

  const finished4 = waitFor<SmokeMatchResult>(alice.socket, 'match:finished', 120_000);
  await startRound(alice.socket, bob.socket, chai.socket);
  await surrenderAll(trio);
  const result4 = await finished4;

  check('ห้องสร้างเอง 3 คนเล่นจนจบได้', result4 !== null);
  check('โหมด custom ไม่ปรับคะแนน (ratingApplied = false)', result4?.ratingApplied === false);
  check(
    'โหมด custom: elo ทั้งสามช่องเป็น null ทุกคน',
    result4?.results.every(
      (entry) => entry.eloBefore === null && entry.eloAfter === null && entry.eloChange === null,
    ) === true,
    result4?.results.map((entry) => [entry.username, entry.eloChange]),
  );

  const multi4 = await prisma.multiplayerMatch.findFirst({
    orderBy: { multiplayerMatchId: 'desc' },
    include: { participants: true },
  });
  check('room_mode = CUSTOM', multi4?.roomMode === RoomMode.CUSTOM, multi4?.roomMode);
  check('player_count = 3', multi4?.playerCount === 3, multi4?.playerCount);
  check('โหมด custom เก็บรหัสห้องไว้', multi4?.roomCode === roomCode, multi4?.roomCode);
  check(
    'participant: elo_before / elo_change เป็น NULL ทั้งหมด',
    multi4?.participants.every((row) => row.eloBefore === null && row.eloChange === null) === true,
    multi4?.participants.map((row) => [row.userId, row.eloBefore, row.eloChange]),
  );
  check(
    'participant: SURRENDERED และเวลาเป็น NULL ทุกแถว',
    multi4?.participants.every(
      (row) => row.result === SolveResult.SURRENDERED && row.solveTime === null,
    ) === true,
    multi4?.participants.map((row) => [row.result, row.solveTime?.toString()]),
  );

  const after4 = await ratingSnapshot(trio);
  check(
    'Rating: ห้อง custom ไม่ขยับ elo แต่ยังนับ matches_played กับ draws',
    trio.every(
      (player) =>
        after4.get(player.userId)!.eloRating === after3.get(player.userId)!.eloRating &&
        after4.get(player.userId)!.matchesPlayed ===
          after3.get(player.userId)!.matchesPlayed + 1 &&
        after4.get(player.userId)!.draws === after3.get(player.userId)!.draws + 1,
    ),
    trio.map((player) => [
      player.name,
      after4.get(player.userId)!.eloRating,
      after4.get(player.userId)!.matchesPlayed,
    ]),
  );

  // ---------------------------------------------------------------- เก็บกวาด
  await leaveRoomAll(trio);
  await sleep(200);
  for (const player of players) player.socket.close();

  const code = summary();
  await prisma.$disconnect();
  process.exit(code);
}

main().catch(async (error: unknown) => {
  console.error('\n💥 ทดสอบล้ม:', error);
  await prisma.$disconnect();
  process.exit(1);
});
