/**
 * ปุ่ม "เสร็จทันที" ของห้องแข่ง — `solve:dev_finish` (เฟส 12 ก้อนที่ 3 · ADR-060)
 * ⚠️ ของชั่วคราว — ถอดออกพร้อมปุ่มก่อน deploy (roadmap เฟส 11)
 *
 * ต้องมี server รันอยู่ + DB ที่ seed แล้ว · รันได้กับ server สองแบบ ตัวสคริปต์ดูเองจาก snapshot:
 *   - สวิตช์ปิด (ค่าเริ่มต้น) → `devInstantFinish = false` และ server ปฏิเสธแม้อยู่ระหว่างจับเวลา
 *   - สวิตช์เปิด (`DEV_INSTANT_FINISH=true`) → เล่นจนจบด้วยปุ่มนี้ทั้งสองคน แล้วตรวจผลที่ได้
 * รันด้วย: npm run smoke:dev-finish     (ชี้ server อื่นด้วย SMOKE_SERVER_URL · ~25 วินาที)
 */
import {
  check,
  connect,
  emit,
  login,
  sendMoves,
  SERVER_URL,
  startRound,
  summary,
  waitFor,
  type SmokeMatchResult,
} from './smoke-helpers.js';

const CUBE_TYPE = '2x2x2';

interface Snapshot {
  devInstantFinish?: unknown;
}

async function main(): Promise<void> {
  console.log(`\n⏩ ทดสอบปุ่มเสร็จทันทีของห้องแข่งที่ ${SERVER_URL} (${CUBE_TYPE})\n`);

  const [alice, bob] = await Promise.all([login('somchai'), login('malee')]);
  const aliceSocket = await connect(alice.token);
  const bobSocket = await connect(bob.token);
  await emit(aliceSocket, 'net:ping', { clientTs: Date.now(), lastRttMs: 20 });

  const created = await emit<{ roomId: number; roomCode: string }>(aliceSocket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'custom',
    maxPlayers: 2,
  });
  if (!created.ok) throw new Error(`สร้างห้องไม่ผ่าน: ${created.error.code}`);
  const joined = await emit<{ snapshot: Snapshot }>(bobSocket, 'room:join', {
    roomCode: created.data.roomCode,
    as: 'player',
  });
  if (!joined.ok) throw new Error(`เข้าห้องไม่ผ่าน: ${joined.error.code}`);

  const flag = joined.data.snapshot.devInstantFinish;
  check('snapshot มี devInstantFinish เป็น boolean', typeof flag === 'boolean', flag);
  const enabled = flag === true;
  console.log(`  ℹ️  server นี้${enabled ? 'เปิด' : 'ปิด'}สวิตช์ DEV_INSTANT_FINISH\n`);

  const early = await emit(aliceSocket, 'solve:dev_finish', {});
  check(
    'กดก่อนเริ่มแมตช์ → E_INVALID_STATE',
    !early.ok && early.error.code === 'E_INVALID_STATE',
    early,
  );

  await startRound(aliceSocket, bobSocket);

  if (!enabled) {
    console.log('สวิตช์ปิด');
    const refused = await emit(aliceSocket, 'solve:dev_finish', {});
    check(
      'ระหว่างจับเวลาก็ยังถูกปฏิเสธ → E_INVALID_STATE',
      !refused.ok && refused.error.code === 'E_INVALID_STATE',
      refused,
    );

    const finished = waitFor<SmokeMatchResult>(aliceSocket, 'match:finished');
    await emit(aliceSocket, 'solve:surrender', {});
    await emit(bobSocket, 'solve:surrender', {});
    const result = await finished;
    check(
      'ปุ่มไม่ได้ทำให้ใครแก้เสร็จ — จบด้วย DNF ทั้งคู่',
      result?.results.every((row) => row.solveTimeMs === null) === true,
      result?.results,
    );
  } else {
    console.log('สวิตช์เปิด — alice หมุนจริง 2 ท่าแล้วกดปุ่ม · bob กดตามโดยไม่หมุนเลย');
    await sendMoves(aliceSocket, ['R', 'U']);
    // ให้ 2 ท่าข้างบนถึง server ก่อน — `solve:move` ไม่มี ack ให้รอ
    await new Promise((resolve) => setTimeout(resolve, 300));

    const bobSeesSolved = waitFor<{ userId: number; moveCount: number; rankNo: number }>(
      bobSocket,
      'player:solved',
    );
    const finalCountdown = waitFor<{ firstSolverUserId: number }>(
      bobSocket,
      'match:final_countdown',
    );
    const first = await emit<{ solveTimeMs: number; rankNo: number }>(
      aliceSocket,
      'solve:dev_finish',
      {},
    );
    check(
      'alice กดแล้วได้ ack แบบ solve:solved (solveTimeMs + rankNo 1)',
      first.ok && typeof first.data.solveTimeMs === 'number' && first.data.rankNo === 1,
      first,
    );

    const solvedEvent = await bobSeesSolved;
    check(
      'คู่แข่งได้ player:solved · moveCount = ท่าที่หมุนจริง (2)',
      solvedEvent?.userId === alice.userId && solvedEvent.moveCount === 2,
      solvedEvent,
    );
    const countdown = await finalCountdown;
    check(
      'เข้า FINAL_COUNTDOWN โดยมี alice เป็นคนแรก',
      countdown?.firstSolverUserId === alice.userId,
      countdown,
    );

    const again = await emit(aliceSocket, 'solve:dev_finish', {});
    check(
      'กดซ้ำหลังจบรอบของตัวเอง → E_INVALID_STATE',
      !again.ok && again.error.code === 'E_INVALID_STATE',
      again,
    );

    const finished = waitFor<SmokeMatchResult>(aliceSocket, 'match:finished');
    const second = await emit<{ solveTimeMs: number; rankNo: number }>(
      bobSocket,
      'solve:dev_finish',
      {},
    );
    check('bob กดตามได้อันดับ 2', second.ok && second.data.rankNo === 2, second);

    const result = await finished;
    const aliceRow = result?.results.find((row) => row.userId === alice.userId);
    const bobRow = result?.results.find((row) => row.userId === bob.userId);
    check(
      'ครบทั้งสองคน → match:finished ทันที · มีเวลาทั้งคู่',
      aliceRow?.solveTimeMs != null && bobRow?.solveTimeMs != null,
      result?.results,
    );
    check(
      'ผลใช้เวลาเดียวกับ ack · moveCount ไม่ถูกแตะ (2 / 0)',
      first.ok &&
        aliceRow?.solveTimeMs === first.data.solveTimeMs &&
        aliceRow.moveCount === 2 &&
        bobRow?.moveCount === 0,
      { aliceRow, bobRow },
    );
    check(
      'บันทึกลงตาราง Match ตามปกติ (matchId + matchKind 1v1)',
      result?.matchId != null && result.matchKind === '1v1',
      result && { matchId: result.matchId, matchKind: result.matchKind },
    );
  }

  await emit(aliceSocket, 'room:leave', {});
  await emit(bobSocket, 'room:leave', {});
  aliceSocket.disconnect();
  bobSocket.disconnect();

  process.exitCode = summary(enabled ? '(สวิตช์เปิด)' : '(สวิตช์ปิด — รันซ้ำกับ server ที่เปิดสวิตช์ด้วย)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
