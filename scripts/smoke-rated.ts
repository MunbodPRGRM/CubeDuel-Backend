/**
 * เล่นแมตช์ **ห้องแข่งขัน** จนจบผ่าน Socket.IO แล้วตรวจว่า Elo ขยับถูกทั้งสองฝั่ง (เฟส 5 ก้อนที่ 1)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * และต้องตั้ง `ALLOW_TEST_COMPETITIVE_ROOM=1` ใน `.env` ของ server (ADR-038)
 * รันด้วย: npm run smoke:rated     (ใช้เวลาราว 60 วินาที เพราะรอ inspection 15 วิ 3 รอบจริง ๆ)
 *
 * ครอบ: ปรับ Elo จริงในห้อง competitive · ผลรวม delta เป็นศูนย์ · คอลัมน์ Elo ใน `Match` ·
 *       ตัวเลขสรุปใน `Rating` (elo/wins/losses/draws/best_time) · เคสเสมอจากการยอมแพ้ทั้งคู่ ·
 *       Elo ที่ปรับแล้วสะท้อนกลับเข้าห้องเดิม · MatchFlag เกณฑ์ WIN_STREAK
 */
import { CubeType, PrismaClient, RoomType, SolveResult } from '@prisma/client';
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

/** สร้างห้องแข่งขัน (ต้องเปิดสวิตช์ทดสอบไว้) แล้วพาอีกฝ่ายเข้าห้อง */
async function openRatedRoom(host: Player, guest: Player): Promise<{ roomId: number }> {
  const created = await emit<{ roomId: number; roomCode: string }>(host.socket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'competitive',
    maxPlayers: 2,
  });
  if (!created.ok) {
    throw new Error(
      `สร้างห้องแข่งขันไม่ได้ (${created.error.code}) — ตั้ง ALLOW_TEST_COMPETITIVE_ROOM=1 ใน .env ของ server แล้วรีสตาร์ทหรือยัง?`,
    );
  }
  const joined = await emit(guest.socket, 'room:join', {
    roomCode: created.data.roomCode,
    as: 'player',
  });
  if (!joined.ok) throw new Error('เข้าห้องไม่ผ่าน');
  return { roomId: created.data.roomId };
}

/** แก้คิวบ์ให้เสร็จจริงด้วยจังหวะเหมือนคนหมุน (ช้าพอไม่ให้ติดเกณฑ์ soft) */
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
  console.log(`\n🏆 ทดสอบห้องแข่งขัน + Elo (${CUBE_TYPE})\n`);

  const [aliceAuth, bobAuth] = await Promise.all([login('somchai'), login('malee')]);
  const alice: Player = { ...aliceAuth, socket: await connect(aliceAuth.token) };
  const bob: Player = { ...bobAuth, socket: await connect(bobAuth.token) };

  // เริ่มจากคะแนนเท่ากันทั้งคู่ ตัวเลขที่คาดหวังจะได้ไม่ขึ้นกับผลรันครั้งก่อน
  await Promise.all([setElo(alice.userId, BASELINE_ELO), setElo(bob.userId, BASELINE_ELO)]);
  const before1 = (await ratingOf(alice.userId))!;
  const bobBefore1 = (await ratingOf(bob.userId))!;

  // ---------------------------------------------------------------- รอบที่ 1
  console.log('รอบที่ 1 — คะแนนเท่ากัน แล้วมีผู้ชนะชัดเจน');
  await openRatedRoom(alice, bob);
  const finished1 = waitFor<SmokeMatchResult>(alice.socket, 'match:finished');
  const round1 = await startRound(alice.socket, bob.socket);
  await emit(bob.socket, 'solve:surrender', {});
  await solve(alice, round1.scramble);
  const result1 = await finished1;

  check(
    'ห้องแข่งขันปรับคะแนนจริง (ratingApplied = true)',
    result1?.ratingApplied === true,
    result1,
  );
  const aliceResult1 = result1?.results.find((entry) => entry.userId === alice.userId);
  const bobResult1 = result1?.results.find((entry) => entry.userId === bob.userId);
  check(
    'คะแนนเท่ากัน 1000 → ผู้ชนะ +16 ผู้แพ้ -16 (K = 32)',
    aliceResult1?.eloChange === 16 && bobResult1?.eloChange === -16,
    { alice: aliceResult1?.eloChange, bob: bobResult1?.eloChange },
  );
  check(
    'ผลส่งคืน elo ก่อน/หลัง ครบทั้งสองฝั่ง',
    aliceResult1?.eloBefore === 1000 &&
      aliceResult1.eloAfter === 1016 &&
      bobResult1?.eloBefore === 1000 &&
      bobResult1.eloAfter === 984,
    result1?.results,
  );

  const match1 = await prisma.match.findUnique({ where: { matchId: result1!.matchId! } });
  check('room_type = COMPETITIVE', match1?.roomType === RoomType.COMPETITIVE, match1?.roomType);
  check(
    'ห้องแข่งขันไม่เก็บรหัสห้อง (คอลัมน์นี้มีความหมายเฉพาะห้องสร้างเอง)',
    match1?.roomCode === null,
    match1?.roomCode,
  );
  check(
    'คอลัมน์ Elo ใน Match ครบทั้ง 4 ช่องและตรงกับที่ส่งให้ client',
    match1?.player1EloBefore === 1000 &&
      match1.player1EloChange === 16 &&
      match1.player2EloBefore === 1000 &&
      match1.player2EloChange === -16,
    {
      p1: [match1?.player1EloBefore, match1?.player1EloChange],
      p2: [match1?.player2EloBefore, match1?.player2EloChange],
    },
  );
  check(
    'ผลรวม elo_change ของสองฝั่งเป็นศูนย์',
    (match1?.player1EloChange ?? 0) + (match1?.player2EloChange ?? 0) === 0,
  );
  check('คนที่ยอมแพ้บันทึกเป็น SURRENDERED', match1?.player2Result === SolveResult.SURRENDERED);

  const after1 = (await ratingOf(alice.userId))!;
  const bobAfter1 = (await ratingOf(bob.userId))!;
  check(
    'Rating: elo ของผู้ชนะขยับตาม elo_change ในทรานแซกชันเดียวกัน',
    after1.eloRating === 1016 && bobAfter1.eloRating === 984,
    { alice: after1.eloRating, bob: bobAfter1.eloRating },
  );
  check(
    'Rating: wins/losses/matches_played ขยับข้างละหนึ่ง',
    after1.wins === before1.wins + 1 &&
      after1.matchesPlayed === before1.matchesPlayed + 1 &&
      bobAfter1.losses === bobBefore1.losses + 1,
    { wins: after1.wins, losses: bobAfter1.losses },
  );
  check(
    'Rating: best_time ของผู้ชนะถูกอัปเดต (หรือดีกว่าเดิมอยู่แล้ว)',
    after1.bestTime !== null,
    after1.bestTime?.toString(),
  );

  // ---------------------------------------------------------------- รอบที่ 2
  console.log('\nรอบที่ 2 — ยอมแพ้ทั้งคู่ → เสมอ (คะแนนไม่เท่ากันแล้ว)');
  const finished2 = waitFor<SmokeMatchResult>(alice.socket, 'match:finished');
  await startRound(alice.socket, bob.socket);
  await emit(alice.socket, 'solve:surrender', {});
  await emit(bob.socket, 'solve:surrender', {});
  const result2 = await finished2;

  const aliceResult2 = result2?.results.find((entry) => entry.userId === alice.userId);
  const bobResult2 = result2?.results.find((entry) => entry.userId === bob.userId);
  check(
    'Elo ที่ปรับไปแล้วสะท้อนกลับเข้าห้องเดิม (รอบใหม่เริ่มจาก 1016 / 984)',
    aliceResult2?.eloBefore === 1016 && bobResult2?.eloBefore === 984,
    { alice: aliceResult2?.eloBefore, bob: bobResult2?.eloBefore },
  );
  check(
    'เสมอ → คนที่คะแนนสูงกว่าเสียคะแนน คนที่ต่ำกว่าได้คะแนน และผลรวมเป็นศูนย์',
    aliceResult2?.eloChange === -1 &&
      bobResult2?.eloChange === 1 &&
      aliceResult2.eloChange + bobResult2.eloChange === 0,
    { alice: aliceResult2?.eloChange, bob: bobResult2?.eloChange },
  );

  const match2 = await prisma.match.findUnique({ where: { matchId: result2!.matchId! } });
  check('DNF ทั้งคู่ → winner_id = NULL', match2?.winnerId === null, match2?.winnerId);
  check(
    'เวลาเป็น NULL ทั้งสองฝั่ง (ห้ามใช้ 0 แทน DNF)',
    match2?.player1Time === null && match2.player2Time === null,
  );

  const after2 = (await ratingOf(alice.userId))!;
  const bobAfter2 = (await ratingOf(bob.userId))!;
  check(
    'Rating: draws +1 ทั้งสองฝั่ง และ elo ขยับตามผลเสมอ',
    after2.draws === after1.draws + 1 &&
      bobAfter2.draws === bobAfter1.draws + 1 &&
      after2.eloRating === 1015 &&
      bobAfter2.eloRating === 985,
    { alice: after2.eloRating, bob: bobAfter2.eloRating, draws: after2.draws },
  );

  await emit(alice.socket, 'room:leave', {});
  await emit(bob.socket, 'room:leave', {});

  // ---------------------------------------------------------------- รอบที่ 3
  console.log('\nรอบที่ 3 — ชนะรวดผิดปกติ → MatchFlag WIN_STREAK');
  // ห่างกัน 600 แต้ม เพื่อให้เข้าเงื่อนไข "Elo ต่างจากคู่แข่งเกิน 300"
  await setElo(alice.userId, 1600);
  await setElo(bob.userId, 1000);

  // ประวัติชนะรวด 20 แมตช์ก่อนหน้า — ยัดลง DB ตรง ๆ เพราะเล่นจริง 20 รอบใช้เวลาเกิน 10 นาที
  const history = await prisma.$transaction(
    Array.from({ length: 20 }, () =>
      prisma.match.create({
        data: {
          roomType: RoomType.COMPETITIVE,
          cubeType: PRISMA_CUBE_TYPE,
          player1Id: alice.userId,
          player2Id: bob.userId,
          scramble: 'R U R- U-',
          player1Result: SolveResult.SOLVED,
          player2Result: SolveResult.DNF,
          player1EloBefore: 1600,
          player1EloChange: 1,
          player2EloBefore: 1000,
          player2EloChange: -1,
          winnerId: alice.userId,
          finishedAt: new Date(),
        },
        select: { matchId: true },
      }),
    ),
  );

  await openRatedRoom(alice, bob);
  const finished3 = waitFor<SmokeMatchResult>(alice.socket, 'match:finished');
  const round3 = await startRound(alice.socket, bob.socket);
  await emit(bob.socket, 'solve:surrender', {});
  await solve(alice, round3.scramble);
  const result3 = await finished3;

  const aliceResult3 = result3?.results.find((entry) => entry.userId === alice.userId);
  check(
    'ห้องใหม่อ่าน Elo ล่าสุดจาก DB (1600 vs 1000) → ชนะคนอ่อนกว่ามากได้แค่ +1',
    aliceResult3?.eloBefore === 1600 && aliceResult3.eloChange === 1,
    { before: aliceResult3?.eloBefore, change: aliceResult3?.eloChange },
  );

  const flags = await prisma.matchFlag.findMany({ where: { matchId: result3!.matchId! } });
  const streakFlag = flags.find((flag) => flag.flagReason === 'WIN_STREAK');
  check(
    'ชนะติดกัน 21 แมตช์แบบห่างชั้น → บันทึก MatchFlag WIN_STREAK ให้ผู้ชนะ',
    streakFlag?.userId === alice.userId,
    flags.map((flag) => ({ userId: flag.userId, reason: flag.flagReason })),
  );
  check(
    'flag เก็บตัวเลขที่วัดได้เทียบกับเกณฑ์',
    (streakFlag?.detail as { measured?: number } | null)?.measured === 21,
    streakFlag?.detail,
  );

  // ---------------------------------------------------------------- เก็บกวาด
  await emit(alice.socket, 'room:leave', {});
  await emit(bob.socket, 'room:leave', {});
  alice.socket.close();
  bob.socket.close();
  await prisma.match.deleteMany({
    where: { matchId: { in: history.map((row) => row.matchId) } },
  });
  console.log(`  🧹 ลบประวัติปลอม ${history.length} แมตช์ทิ้งแล้ว`);

  const code = summary();
  await prisma.$disconnect();
  process.exit(code);
}

main().catch(async (error: unknown) => {
  console.error('\n💥 ทดสอบล้ม:', error);
  await prisma.$disconnect();
  process.exit(1);
});
