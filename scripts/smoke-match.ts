/**
 * เล่นแมตช์จริงจนจบผ่าน Socket.IO แล้วตรวจว่าผลลงตาราง `Match` ถูกต้อง (เฟส 4 ก้อนที่ 2)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * รันด้วย: npm run smoke:match     (ใช้เวลาราว 45 วินาที เพราะรอ inspection 15 วิ 2 รอบจริง ๆ)
 *
 * ครอบ: ลำดับ LOADING → COUNTDOWN → INSPECTION → SOLVING → FINAL_COUNTDOWN → FINISHED ·
 *       ห้ามหมุนช่วง inspection · seq ผิด · move ผิดประเภท · อ้างว่าเสร็จทั้งที่ยังไม่เสร็จ ·
 *       เห็น move คู่แข่ง · ยอมแพ้ · บันทึก DB + ตัวเลขสรุปใน Rating · เล่นซ้ำในห้องเดิม
 */
import { PrismaClient } from '@prisma/client';
import {
  check,
  connect,
  emit,
  login,
  sendMoves,
  SERVER_URL,
  solutionMoves,
  summary,
  waitFor,
  type SmokeMatchResult,
} from './smoke-helpers.js';

const CUBE_TYPE = '2x2x2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log(`\n🎮 ทดสอบแมตช์เต็มรูปแบบที่ ${SERVER_URL} (${CUBE_TYPE})\n`);

  const [alice, bob] = await Promise.all([login('somchai'), login('malee')]);
  const aliceSocket = await connect(alice.token);
  const bobSocket = await connect(bob.token);

  // ตั้งค่า RTT ให้ server รู้ (ใช้ชดเชยเวลาตอนตัดสิน)
  await emit(aliceSocket, 'net:ping', { clientTs: Date.now(), lastRttMs: 20 });

  // อ่านคะแนนไว้ก่อน — ห้องสร้างเองต้องไม่ทำให้ตัวเลขนี้ขยับ (ค่าจริงขึ้นกับว่าเคยรัน smoke:rated มาก่อนไหม)
  const eloBeforeAll = (
    await prisma.rating.findUnique({
      where: { userId_cubeType: { userId: alice.userId, cubeType: 'CUBE_2X2X2' } },
    })
  )?.eloRating;

  const created = await emit<{ roomId: number; roomCode: string }>(aliceSocket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'custom',
    maxPlayers: 2,
  });
  if (!created.ok) throw new Error('สร้างห้องไม่ผ่าน');
  const { roomId, roomCode } = created.data;
  await emit(bobSocket, 'room:join', { roomCode, as: 'player' });

  // ---------------------------------------------------------------- เงื่อนไขก่อนเริ่ม
  console.log('เงื่อนไขก่อนกดเริ่ม');
  const notHost = await emit(bobSocket, 'room:start', {});
  check(
    'คนที่ไม่ใช่ host กดเริ่มไม่ได้ → E_NOT_HOST',
    !notHost.ok && notHost.error.code === 'E_NOT_HOST',
    notHost,
  );

  const earlyMove = waitFor<{ code: string }>(aliceSocket, 'error', 2_000);
  aliceSocket.emit('solve:move', { seq: 1, move: 'R', clientTs: Date.now() });
  const earlyMoveError = await earlyMove;
  check(
    'หมุนคิวบ์ก่อนเริ่มแมตช์ไม่ได้ → E_INVALID_STATE',
    earlyMoveError?.code === 'E_INVALID_STATE',
    earlyMoveError,
  );

  // ---------------------------------------------------------------- รอบที่ 1
  console.log('\nรอบที่ 1 — ทั้งคู่แก้เสร็จ');
  const aliceLoading = waitFor<{ scramble: string; deadlineTs: number }>(
    aliceSocket,
    'match:loading',
  );
  const bobLoading = waitFor<{ scramble: string }>(bobSocket, 'match:loading');
  const started = await emit(aliceSocket, 'room:start', {});
  check('host กดเริ่มได้', started.ok, started);

  const loading = await aliceLoading;
  const bobLoadingPayload = await bobLoading;
  check(
    'ทั้งสองฝั่งได้ match:loading พร้อม scramble',
    loading !== null && bobLoadingPayload !== null,
  );
  check(
    'ผู้เล่นทุกคนได้ scramble ชุดเดียวกัน',
    loading?.scramble === bobLoadingPayload?.scramble && (loading?.scramble.length ?? 0) > 0,
    loading?.scramble,
  );
  const scramble = loading!.scramble;

  const countdown = waitFor<{ durationMs: number }>(aliceSocket, 'match:countdown');
  await emit(aliceSocket, 'solve:ready', {});
  await emit(bobSocket, 'solve:ready', {});
  const countdownPayload = await countdown;
  check(
    'พร้อมครบทุกคน → เข้า COUNTDOWN 3 วิ ทันที ไม่รอครบ 15 วิ',
    countdownPayload?.durationMs === 3_000,
    countdownPayload,
  );

  const inspection = await waitFor<{ endsAtTs: number; durationMs: number }>(
    aliceSocket,
    'match:inspection_started',
  );
  check('เข้า INSPECTION 15 วิ', inspection?.durationMs === 15_000, inspection);

  const inspectionMove = waitFor<{ code: string }>(bobSocket, 'error', 3_000);
  bobSocket.emit('solve:move', { seq: 1, move: 'R', clientTs: Date.now() });
  const inspectionError = await inspectionMove;
  check(
    'หมุนหน้าคิวบ์ระหว่าง inspection ไม่ได้ → E_MOVE_DURING_INSPECTION',
    inspectionError?.code === 'E_MOVE_DURING_INSPECTION',
    inspectionError,
  );

  const startedAt = await waitFor<{ serverStartTs: number }>(aliceSocket, 'match:started');
  check('เริ่มจับเวลาพร้อมกัน (match:started)', startedAt !== null, startedAt);

  // อ้างว่าเสร็จทั้งที่ยังไม่ได้หมุนอะไรเลย
  const liar = await emit(bobSocket, 'solve:solved', {
    seq: 0,
    moveCount: 0,
    clientTs: Date.now(),
  });
  check(
    'อ้างว่าแก้เสร็จทั้งที่ยังไม่เสร็จ → E_NOT_SOLVED',
    !liar.ok && liar.error.code === 'E_NOT_SOLVED',
    liar,
  );

  const badMove = waitFor<{ code: string }>(bobSocket, 'error', 2_000);
  bobSocket.emit('solve:move', { seq: 9, move: 'R', clientTs: Date.now() });
  check('seq ข้ามลำดับ → E_SEQ_MISMATCH', (await badMove)?.code === 'E_SEQ_MISMATCH');

  const wrongNotation = waitFor<{ code: string }>(bobSocket, 'error', 2_000);
  bobSocket.emit('solve:move', { seq: 1, move: 'M', clientTs: Date.now() });
  check(
    'move ที่ไม่มีใน 2x2x2 (M) → E_INVALID_MOVE',
    (await wrongNotation)?.code === 'E_INVALID_MOVE',
  );

  const moves = solutionMoves(scramble);
  const seenOpponentMove = waitFor<{ userId: number; move: string }>(bobSocket, 'opponent:move');
  // alice ยิง move รวดเดียวแล้วแจ้งเสร็จทันที — จงใจให้เข้าเกณฑ์ soft ครบ 3 ข้อ (game-rules.md ข้อ 10)
  await sendMoves(aliceSocket, moves);
  const opponentMove = await seenOpponentMove;
  check(
    'คู่แข่งเห็น move แบบ real-time (opponent:move)',
    opponentMove?.userId === alice.userId && opponentMove.move === moves[0],
    opponentMove,
  );

  const finalCountdown = waitFor<{ firstSolverUserId: number; durationMs: number }>(
    bobSocket,
    'match:final_countdown',
  );
  const aliceSolved = await emit<{ solveTimeMs: number; rankNo: number }>(
    aliceSocket,
    'solve:solved',
    { seq: moves.length, moveCount: moves.length, clientTs: Date.now() },
  );
  check('แก้เสร็จจริง → ได้เวลาและอันดับกลับมา', aliceSolved.ok, aliceSolved);
  if (aliceSolved.ok) {
    check('อันดับที่ 1 (คนแรกที่เสร็จ)', aliceSolved.data.rankNo === 1, aliceSolved.data);
  }
  const finalPayload = await finalCountdown;
  check(
    'คนแรกเสร็จ → นับถอยหลัง 10 วินาที',
    finalPayload?.durationMs === 10_000 && finalPayload.firstSolverUserId === alice.userId,
    finalPayload,
  );

  const finished = waitFor<SmokeMatchResult>(aliceSocket, 'match:finished');
  // bob หมุนด้วยจังหวะเท่าคนจริง (~8 move/วินาที) — ต้องไม่โดน flag และเวลาต้องตรงกับที่ผ่านไปจริง
  await sendMoves(bobSocket, moves, 120);
  const bobSolved = await emit<{ rankNo: number; solveTimeMs: number }>(bobSocket, 'solve:solved', {
    seq: moves.length,
    moveCount: moves.length,
    clientTs: Date.now(),
  });
  check('คนที่สองแก้เสร็จได้อันดับ 2', bobSolved.ok && bobSolved.data.rankNo === 2, bobSolved);
  check(
    'เวลาที่ server จับได้ตรงกับเวลาที่ผ่านไปจริง (~1.5 วิ)',
    bobSolved.ok && bobSolved.data.solveTimeMs > 1_200 && bobSolved.data.solveTimeMs < 5_000,
    bobSolved.ok ? bobSolved.data.solveTimeMs : bobSolved,
  );

  const result = await finished;
  check('ทุกคนจบ → แมตช์จบทันทีไม่ต้องรอครบ 10 วิ', result !== null, result);
  check('ห้องสร้างเองไม่ปรับ Elo (ratingApplied = false)', result?.ratingApplied === false);
  check(
    'ผลไม่มี eloChange และเรียงตามอันดับแล้ว',
    result?.results.every((entry) => entry.eloChange === null) === true &&
      result?.results[0]?.rankNo === 1,
    result?.results,
  );
  check(
    'ได้ match_id กลับมา (บันทึก DB แล้ว)',
    typeof result?.matchId === 'number',
    result?.matchId,
  );

  // ---------------------------------------------------------------- ตรวจ DB
  console.log('\nตรวจข้อมูลที่ลง DB');
  const matchRow = await prisma.match.findUnique({ where: { matchId: result!.matchId! } });
  check('มีแถวใน Match', matchRow !== null);
  check(
    'room_type = CUSTOM + เก็บรหัสห้องไว้',
    matchRow?.roomType === 'CUSTOM' && matchRow.roomCode === roomCode,
    {
      roomType: matchRow?.roomType,
      roomCode: matchRow?.roomCode,
    },
  );
  check(
    'ผู้เล่นคนแรกที่เข้าห้องเป็น player1',
    matchRow?.player1Id === alice.userId,
    matchRow?.player1Id,
  );
  check(
    'ทั้งคู่ result = SOLVED',
    matchRow?.player1Result === 'SOLVED' && matchRow.player2Result === 'SOLVED',
  );
  check(
    'เวลาบันทึกเป็นวินาทีทศนิยม 2 ตำแหน่ง',
    matchRow?.player2Time != null && Number(matchRow.player2Time) > 1,
    matchRow?.player2Time?.toString(),
  );
  check(
    'คอลัมน์ Elo เป็น NULL ทั้ง 4 ช่อง (ห้องไม่ปรับคะแนน)',
    matchRow?.player1EloBefore === null &&
      matchRow.player1EloChange === null &&
      matchRow.player2EloBefore === null &&
      matchRow.player2EloChange === null,
  );
  check('winner_id = คนที่เร็วกว่า', matchRow?.winnerId === alice.userId, matchRow?.winnerId);

  const flags = await prisma.matchFlag.findMany({ where: { matchId: result!.matchId! } });
  const aliceFlag = flags.find((flag) => flag.userId === alice.userId);
  check(
    'เวลาต่ำผิดปกติถูกบันทึกเป็น MatchFlag ไม่ใช่ปฏิเสธผล',
    aliceFlag?.flagReason === 'IMPOSSIBLE_TIME',
    flags.map((flag) => ({ userId: flag.userId, reason: flag.flagReason })),
  );
  check(
    'flag เก็บ move_log ของ solve นั้นไว้ให้แอดมินตรวจ',
    Array.isArray(aliceFlag?.moveLog) && (aliceFlag.moveLog as unknown[]).length === moves.length,
    aliceFlag?.moveLog,
  );
  check(
    'ยิง move รวดเดียวเข้าเกณฑ์ความเร็วการหมุนด้วย (HIGH_TPS + MOVE_GAP)',
    ['HIGH_TPS', 'MOVE_GAP'].every((reason) =>
      flags.some((flag) => flag.userId === alice.userId && flag.flagReason === reason),
    ),
    flags.filter((flag) => flag.userId === alice.userId).map((flag) => flag.flagReason),
  );
  check(
    'คนที่หมุนด้วยจังหวะปกติไม่ถูก flag เลย',
    flags.every((flag) => flag.userId !== bob.userId),
    flags.map((flag) => ({ userId: flag.userId, reason: flag.flagReason })),
  );

  const aliceRating = await prisma.rating.findUnique({
    where: { userId_cubeType: { userId: alice.userId, cubeType: 'CUBE_2X2X2' } },
  });
  check(
    'Rating: best_time ถูกเซ็ตแล้ว และ elo ไม่ขยับเลย (ห้องสร้างเองไม่ปรับคะแนน)',
    aliceRating?.bestTime !== null && aliceRating?.eloRating === eloBeforeAll,
    { bestTime: aliceRating?.bestTime?.toString(), elo: aliceRating?.eloRating, eloBeforeAll },
  );

  // ---------------------------------------------------------------- รอบที่ 2
  console.log('\nรอบที่ 2 — เล่นซ้ำในห้องเดิม + ยอมแพ้');
  const playedBefore = aliceRating!.matchesPlayed;

  const loading2 = waitFor<{ scramble: string }>(aliceSocket, 'match:loading');
  const restart = await emit(aliceSocket, 'room:start', {});
  check('กด "เล่นอีกครั้ง" ในห้องเดิมได้', restart.ok, restart);
  const round2 = await loading2;
  check('รอบใหม่ได้ scramble คนละชุดกับรอบก่อน', round2 !== null && round2.scramble !== scramble);

  await emit(aliceSocket, 'solve:ready', {});
  await emit(bobSocket, 'solve:ready', {});
  await waitFor(aliceSocket, 'match:started');

  const dnfEvent = waitFor<{ userId: number; reason: string }>(aliceSocket, 'player:dnf');
  const finished2 = waitFor<SmokeMatchResult>(aliceSocket, 'match:finished');
  const surrendered = await emit(bobSocket, 'solve:surrender', {});
  check('ยอมแพ้ได้', surrendered.ok, surrendered);
  check('ทั้งห้องเห็น player:dnf reason = surrender', (await dnfEvent)?.reason === 'surrender');

  const moves2 = solutionMoves(round2!.scramble);
  await sendMoves(aliceSocket, moves2, 120);
  await emit(aliceSocket, 'solve:solved', {
    seq: moves2.length,
    moveCount: moves2.length,
    clientTs: Date.now(),
  });
  const result2 = await finished2;
  check('อีกฝ่ายยอมแพ้แล้วแก้เสร็จ → แมตช์จบ', result2 !== null);
  check(
    'คนยอมแพ้ได้ DNF (solveTimeMs = null) และอยู่อันดับ 2',
    result2?.results.find((entry) => entry.userId === bob.userId)?.solveTimeMs === null &&
      result2?.results.find((entry) => entry.userId === bob.userId)?.rankNo === 2,
    result2?.results,
  );

  const match2 = await prisma.match.findUnique({ where: { matchId: result2!.matchId! } });
  check(
    'DB: คนยอมแพ้บันทึกเป็น SURRENDERED + เวลา NULL',
    match2?.player2Result === 'SURRENDERED' && match2.player2Time === null,
    {
      result: match2?.player2Result,
      time: match2?.player2Time,
    },
  );

  const aliceRating2 = await prisma.rating.findUnique({
    where: { userId_cubeType: { userId: alice.userId, cubeType: 'CUBE_2X2X2' } },
  });
  check(
    'Rating: matches_played +1 และ wins เพิ่มขึ้น',
    aliceRating2?.matchesPlayed === playedBefore + 1 && aliceRating2.wins === aliceRating!.wins + 1,
    { before: playedBefore, after: aliceRating2?.matchesPlayed },
  );

  // ---------------------------------------------------------------- รอบที่ 3
  console.log('\nรอบที่ 3 — คู่แข่งหลุดกลางแมตช์ + หมดเวลานับถอยหลัง 10 วิ');
  // ต้องดัก match:loading ก่อนสั่งเริ่ม — server ส่ง event ออกก่อนที่ ack จะกลับมาถึง
  const loading3 = waitFor<{ scramble: string }>(aliceSocket, 'match:loading');
  const restart3 = await emit(aliceSocket, 'room:start', {});
  check('เริ่มรอบใหม่ได้', restart3.ok, restart3);
  const round3 = await loading3;
  await emit(aliceSocket, 'solve:ready', {});
  await emit(bobSocket, 'solve:ready', {});
  await waitFor(aliceSocket, 'match:started');

  const disconnected = waitFor<{ userId: number; graceEndsAtTs: number }>(
    aliceSocket,
    'player:disconnected',
  );
  bobSocket.close();
  const disconnectEvent = await disconnected;
  check(
    'คู่แข่งหลุด → ทั้งห้องรู้พร้อมเวลาหมด grace (30 วิ)',
    disconnectEvent?.userId === bob.userId && disconnectEvent.graceEndsAtTs - Date.now() > 25_000,
    disconnectEvent,
  );

  const finished3 = waitFor<SmokeMatchResult>(aliceSocket, 'match:finished', 20_000);
  await sendMoves(aliceSocket, solutionMoves(round3!.scramble), 120);
  await emit(aliceSocket, 'solve:solved', {
    seq: solutionMoves(round3!.scramble).length,
    moveCount: solutionMoves(round3!.scramble).length,
    clientTs: Date.now(),
  });
  const startedWaiting = Date.now();
  const result3 = await finished3;
  const waited = Date.now() - startedWaiting;
  check('รออีกฝ่ายจนครบ 10 วินาทีแล้วแมตช์จบเอง', result3 !== null && waited > 8_000, waited);
  check(
    'คนที่หลุดได้ DNF (เวลาเป็น null) แต่ผลยังถูกบันทึก',
    result3?.results.find((entry) => entry.userId === bob.userId)?.solveTimeMs === null &&
      typeof result3?.matchId === 'number',
    result3?.results,
  );
  const match3 = await prisma.match.findUnique({ where: { matchId: result3!.matchId! } });
  check('DB: คนที่หลุดบันทึกเป็น DNF', match3?.player2Result === 'DNF', match3?.player2Result);

  // ---------------------------------------------------------------- รอบที่ 4
  console.log('\nรอบที่ 4 — ไม่กลับมาภายใน grace → ถูกถอดออกจากห้อง (รอ ~30 วิ)');
  const kicked = await waitFor<{ userId: number; reason: string }>(
    aliceSocket,
    'room:player_left',
    40_000,
  );
  check(
    'หมด grace แล้วยังไม่กลับ → ถอดออกจากห้อง เหลือคนเดียวในห้อง',
    kicked?.userId === bob.userId && kicked.reason === 'disconnected',
    kicked,
  );

  // ---------------------------------------------------------------- เก็บกวาด
  await emit(aliceSocket, 'room:leave', {});
  aliceSocket.close();
  const code = summary(`(ห้อง ${roomId})`);
  await prisma.$disconnect();
  process.exit(code);
}

main().catch(async (error: unknown) => {
  console.error('\n💥 ทดสอบล้ม:', error);
  await prisma.$disconnect();
  process.exit(1);
});
