/**
 * เล่นห้อง **ผู้เล่นหลายคน** จนจบผ่าน Socket.IO แล้วตรวจตาราง `MultiplayerMatch` +
 * participant + `Rating` (เฟส 6 ก้อนที่ 1)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * และต้องตั้ง `ALLOW_TEST_COMPETITIVE_ROOM=1` ใน `.env` ของ server — ทางเข้าห้องหลายคนจริง
 * (คิว auto + หน้าสร้างห้อง) เป็นงานก้อนที่ 2 ตอนนี้จึงบังคับสร้างห้องผ่านสวิตช์ทดสอบ
 * รันด้วย: npm run smoke:multi     (ใช้เวลาราว 45 วินาที เพราะรอ inspection 15 วิ 2 รอบจริง ๆ)
 *
 * ครอบ: Pairwise Elo จริงในห้อง 4 คนโหมด auto · แถว `MultiplayerMatch` + participant ครบ ·
 *       `Rating` (elo / wins / losses / draws / matches_played / best_time) ของทุกคน ·
 *       `MatchFlag` ผูกกับ `multiplayer_match_id` และ **ไม่มี** `WIN_STREAK` (ADR-041 ข้อ 2) ·
 *       ห้อง 3 คนโหมด custom ไม่ปรับคะแนน · DNF ทั้งห้องต้องไม่พังตอนบันทึก (ADR-041 ข้อ 3)
 */
import { CubeType, PrismaClient, RoomMode, SolveResult } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import {
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

/** สร้างห้องหลายคนแล้วพาที่เหลือเข้าห้องด้วยรหัส — คนแรกในลิสต์เป็น host (seat 1) */
async function openRoom(
  players: Player[],
  roomMode: 'auto' | 'custom',
): Promise<{ roomId: number; roomCode: string }> {
  const [host, ...guests] = players;
  const created = await emit<{ roomId: number; roomCode: string }>(host!.socket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'multiplayer',
    maxPlayers: players.length,
    roomMode,
  });
  if (!created.ok) {
    throw new Error(
      `สร้างห้องหลายคนไม่ได้ (${created.error.code}: ${created.error.message}) — ตั้ง ALLOW_TEST_COMPETITIVE_ROOM=1 ใน .env ของ server แล้วรีสตาร์ทหรือยัง?`,
    );
  }
  for (const guest of guests) {
    const joined = await emit(guest.socket, 'room:join', {
      roomCode: created.data.roomCode,
      as: 'player',
    });
    if (!joined.ok) throw new Error(`${guest.name} เข้าห้องไม่ผ่าน: ${joined.error.code}`);
  }
  return created.data;
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

async function main(): Promise<void> {
  console.log(`\n👥 ทดสอบห้องผู้เล่นหลายคน + Pairwise Elo (${CUBE_TYPE})\n`);

  const names = ['somchai', 'malee', 'nattapong', 'pimchanok'];
  const players: Player[] = [];
  for (const name of names) {
    const auth = await login(name);
    players.push({ name, ...auth, socket: await connect(auth.token) });
  }
  const [alice, bob, chai, dao] = players as [Player, Player, Player, Player];

  // เริ่มจากคะแนนเท่ากันทุกคน ตัวเลขที่คาดหวังจะได้ไม่ขึ้นกับผลรันครั้งก่อน
  await Promise.all(players.map((player) => setElo(player.userId, BASELINE_ELO)));
  const before = new Map(
    await Promise.all(
      players.map(async (player) => [player.userId, (await ratingOf(player.userId))!] as const),
    ),
  );

  // ---------------------------------------------------------------- รอบที่ 1
  console.log('รอบที่ 1 — ห้อง 4 คน โหมด auto: แก้เสร็จ 2 · ยอมแพ้ 2');
  await openRoom(players, 'auto');
  const finished1 = waitFor<SmokeMatchResult>(alice.socket, 'match:finished');
  const round1 = await startRound(alice.socket, bob.socket, chai.socket, dao.socket);

  // Alice หมุนรัว → เร็วจนติดเกณฑ์ soft (ไว้ตรวจว่า MatchFlag ผูกกับแมตช์หลายคนได้)
  await solve(alice, round1.scramble, 0);
  await emit(chai.socket, 'solve:surrender', {});
  await emit(dao.socket, 'solve:surrender', {});
  // Bob แก้เสร็จทีหลังในช่วงนับถอยหลัง 10 วินาที → อันดับ 2
  await solve(bob, round1.scramble, 60);
  const result1 = await finished1;

  check('ได้รับ match:finished ของห้องหลายคน', result1 !== null, result1);
  check('roomKind = multiplayer', result1?.roomKind === 'multiplayer', result1?.roomKind);
  check('โหมด auto ปรับคะแนนจริง (ratingApplied = true)', result1?.ratingApplied === true);
  check(
    'matchId ยังเป็น null — GET /matches/:matchId ยังอ่านแมตช์หลายคนไม่ได้ (ก้อนที่ 3)',
    result1?.matchId === null,
    result1?.matchId,
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
    'โหมด auto ไม่เก็บรหัสห้อง (คอลัมน์นี้มีความหมายเฉพาะโหมด custom)',
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

  const after1 = new Map(
    await Promise.all(
      players.map(async (player) => [player.userId, (await ratingOf(player.userId))!] as const),
    ),
  );
  check(
    'Rating: elo ของทุกคนขยับตาม elo_change ในทรานแซกชันเดียวกัน',
    after1.get(alice.userId)!.eloRating === 1016 &&
      after1.get(bob.userId)!.eloRating === 1006 &&
      after1.get(chai.userId)!.eloRating === 989 &&
      after1.get(dao.userId)!.eloRating === 989,
    players.map((player) => [player.name, after1.get(player.userId)!.eloRating]),
  );
  check(
    'Rating: ผู้ชนะได้ wins +1 · ที่เหลือได้ losses +1 (นับเหมือน 1v1 — ADR-041 ข้อ 1)',
    after1.get(alice.userId)!.wins === before.get(alice.userId)!.wins + 1 &&
      after1.get(bob.userId)!.losses === before.get(bob.userId)!.losses + 1 &&
      after1.get(chai.userId)!.losses === before.get(chai.userId)!.losses + 1 &&
      after1.get(dao.userId)!.losses === before.get(dao.userId)!.losses + 1,
    players.map((player) => [
      player.name,
      after1.get(player.userId)!.wins,
      after1.get(player.userId)!.losses,
    ]),
  );
  check(
    'Rating: matches_played +1 ทุกคน',
    players.every(
      (player) =>
        after1.get(player.userId)!.matchesPlayed ===
        before.get(player.userId)!.matchesPlayed + 1,
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

  for (const player of players) await emit(player.socket, 'room:leave', {});

  // ---------------------------------------------------------------- รอบที่ 2
  console.log('\nรอบที่ 2 — ห้อง 3 คน โหมด custom: ยอมแพ้ทั้งห้อง → DNF หมด ไม่ปรับคะแนน');
  const trio = [alice, bob, chai];
  const room2 = await openRoom(trio, 'custom');
  const finished2 = waitFor<SmokeMatchResult>(alice.socket, 'match:finished');
  await startRound(alice.socket, bob.socket, chai.socket);
  for (const player of trio) await emit(player.socket, 'solve:surrender', {});
  const result2 = await finished2;

  check('DNF ทั้งห้องแล้วยังบันทึกผลได้ ไม่พัง (ADR-041 ข้อ 3)', result2 !== null);
  check('โหมด custom ไม่ปรับคะแนน (ratingApplied = false)', result2?.ratingApplied === false);
  check(
    'โหมด custom: elo ทั้งสามช่องเป็น null ทุกคน',
    result2?.results.every(
      (entry) => entry.eloBefore === null && entry.eloAfter === null && entry.eloChange === null,
    ) === true,
    result2?.results.map((entry) => [entry.username, entry.eloChange]),
  );
  check(
    'ไม่มีใครแก้สำเร็จ → ทุกคนได้อันดับ 1 เท่ากัน (game-rules.md ข้อ 7)',
    result2?.results.every((entry) => entry.rankNo === 1) === true,
    result2?.results.map((entry) => [entry.username, entry.rankNo]),
  );

  const multi2 = await prisma.multiplayerMatch.findFirst({
    orderBy: { multiplayerMatchId: 'desc' },
    include: { participants: true },
  });
  check('room_mode = CUSTOM', multi2?.roomMode === RoomMode.CUSTOM, multi2?.roomMode);
  check('player_count = 3', multi2?.playerCount === 3, multi2?.playerCount);
  check('โหมด custom เก็บรหัสห้องไว้', multi2?.roomCode === room2.roomCode, multi2?.roomCode);
  check(
    'participant: elo_before / elo_change เป็น NULL ทั้งหมด',
    multi2?.participants.every((row) => row.eloBefore === null && row.eloChange === null) === true,
    multi2?.participants.map((row) => [row.userId, row.eloBefore, row.eloChange]),
  );
  check(
    'participant: SURRENDERED และเวลาเป็น NULL ทุกแถว',
    multi2?.participants.every(
      (row) => row.result === SolveResult.SURRENDERED && row.solveTime === null,
    ) === true,
    multi2?.participants.map((row) => [row.result, row.solveTime?.toString()]),
  );

  const after2 = new Map(
    await Promise.all(
      trio.map(async (player) => [player.userId, (await ratingOf(player.userId))!] as const),
    ),
  );
  check(
    'Rating: ไม่มีใครได้อันดับ 1 คนเดียว → draws +1 ทุกคน และ elo ไม่ขยับ',
    trio.every(
      (player) =>
        after2.get(player.userId)!.draws === after1.get(player.userId)!.draws + 1 &&
        after2.get(player.userId)!.eloRating === after1.get(player.userId)!.eloRating,
    ),
    trio.map((player) => [
      player.name,
      after2.get(player.userId)!.draws,
      after2.get(player.userId)!.eloRating,
    ]),
  );
  check(
    'Rating: ห้อง custom ก็ยังนับ matches_played',
    trio.every(
      (player) =>
        after2.get(player.userId)!.matchesPlayed ===
        after1.get(player.userId)!.matchesPlayed + 1,
    ),
  );

  // ---------------------------------------------------------------- เก็บกวาด
  for (const player of players) {
    await emit(player.socket, 'room:leave', {});
    player.socket.close();
  }

  const code = summary();
  await prisma.$disconnect();
  process.exit(code);
}

main().catch(async (error: unknown) => {
  console.error('\n💥 ทดสอบล้ม:', error);
  await prisma.$disconnect();
  process.exit(1);
});
