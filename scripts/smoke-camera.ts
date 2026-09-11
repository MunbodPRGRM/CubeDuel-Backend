/**
 * มุมกล้องของคู่แข่งแบบเรียลไทม์ — `solve:camera` → `opponent:camera` (เฟส 12 ก้อนที่ 5 · ADR-062)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว
 * รันด้วย: npm run smoke:camera     (~25 วินาที — รอ inspection 15 วินาทีจริง)
 *
 * ครอบ: ส่งต่อเฉพาะ INSPECTION / SOLVING (ก่อนเริ่ม · LOADING · FINISHED ไม่ส่ง) · คู่แข่งกับผู้ชมได้ ·
 *       คนส่งไม่ได้ของตัวเองกลับ · payload ผิด/นอกช่วง/ยิงถี่เกิน = ทิ้งเงียบ ไม่มี event `error` กลับมา
 */
import { check, connect, emit, login, SERVER_URL, summary, waitFor } from './smoke-helpers.js';

const CUBE_TYPE = '2x2x2';
/** quaternion ยาว 1 หน่วย (0.1² + 0.2² + 0.3² + 0.9274² ≈ 1) */
const POSE = { q: [0.1, 0.2, 0.3, 0.9274], d: 6.5 };

interface Relayed {
  userId: number;
  q: number[];
  d: number;
}

async function main(): Promise<void> {
  console.log(`\n🎥 ทดสอบมุมกล้องของคู่แข่งที่ ${SERVER_URL} (${CUBE_TYPE})\n`);

  const [alice, bob, eve] = await Promise.all([
    login('somchai'),
    login('malee'),
    login('nattapong'),
  ]);
  const [aliceSocket, bobSocket, eveSocket] = await Promise.all([
    connect(alice.token),
    connect(bob.token),
    connect(eve.token),
  ]);

  const created = await emit<{ roomCode: string }>(aliceSocket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'custom',
    maxPlayers: 2,
  });
  if (!created.ok) throw new Error(`สร้างห้องไม่ผ่าน: ${created.error.code}`);
  const { roomCode } = created.data;
  await emit(bobSocket, 'room:join', { roomCode, as: 'player' });
  const watching = await emit(eveSocket, 'room:join', { roomCode, as: 'spectator' });
  if (!watching.ok) throw new Error(`เข้าเป็นผู้ชมไม่ผ่าน: ${watching.error.code}`);

  // ---------------------------------------------------------------- นอกช่วง
  console.log('นอกช่วงที่ส่งต่อ');
  const waitingRelay = waitFor(bobSocket, 'opponent:camera', 800);
  const waitingError = waitFor(aliceSocket, 'error', 800);
  aliceSocket.emit('solve:camera', POSE);
  check('ยังไม่เริ่มแมตช์ (WAITING) → ไม่ส่งต่อ', (await waitingRelay) === null);
  check('… และไม่มี error กลับไปหาคนส่ง', (await waitingError) === null);

  const loading = waitFor(aliceSocket, 'match:loading');
  const started = await emit(aliceSocket, 'room:start', {});
  if (!started.ok) throw new Error(`กดเริ่มไม่ผ่าน: ${started.error.code}`);
  await loading;

  const loadingRelay = waitFor(bobSocket, 'opponent:camera', 500);
  aliceSocket.emit('solve:camera', POSE);
  check('LOADING → ไม่ส่งต่อ', (await loadingRelay) === null);

  const inspection = waitFor(aliceSocket, 'match:inspection_started');
  await emit(aliceSocket, 'solve:ready', {});
  await emit(bobSocket, 'solve:ready', {});
  if (!(await inspection)) throw new Error('ไม่ได้เข้า INSPECTION');
  // ดักไว้ก่อนเลย — match:started มาหลัง inspection 15 วินาที ระหว่างนั้นทดสอบอย่างอื่นอยู่
  const solving = waitFor(aliceSocket, 'match:started', 30_000);

  // ---------------------------------------------------------------- INSPECTION
  console.log('\nINSPECTION');
  const toBob = waitFor<Relayed>(bobSocket, 'opponent:camera', 2_000);
  const toEve = waitFor<Relayed>(eveSocket, 'opponent:camera', 2_000);
  const echo = waitFor(aliceSocket, 'opponent:camera', 800);
  aliceSocket.emit('solve:camera', POSE);
  const relayed = await toBob;
  check(
    'คู่แข่งได้ opponent:camera พร้อม userId ของคนส่ง + ค่าเดิมเป๊ะ',
    relayed?.userId === alice.userId &&
      JSON.stringify(relayed.q) === JSON.stringify(POSE.q) &&
      relayed.d === POSE.d,
    relayed,
  );
  check('ผู้ชมได้ด้วย', (await toEve)?.userId === alice.userId);
  check('คนส่งไม่ได้ของตัวเองกลับมา', (await echo) === null);

  const badRelay = waitFor(bobSocket, 'opponent:camera', 800);
  const badError = waitFor(aliceSocket, 'error', 800);
  aliceSocket.emit('solve:camera', { q: [0, 0, 1], d: 5 }); // ขาดช่อง
  aliceSocket.emit('solve:camera', { q: [0, 0, 0, 1], d: 1e9 }); // ระยะนอกช่วง
  aliceSocket.emit('solve:camera', { q: [0.5, 0, 0, 0.5], d: 5 }); // ไม่ยาว 1 หน่วย
  check('payload ผิดรูป/นอกช่วง → ไม่ส่งต่อ', (await badRelay) === null);
  check('… และทิ้งเงียบ ไม่มี error กลับ', (await badError) === null);

  const spectatorRelay = waitFor(aliceSocket, 'opponent:camera', 800);
  eveSocket.emit('solve:camera', POSE);
  check('ผู้ชมส่งมุมกล้องไม่ได้ → ไม่ส่งต่อ', (await spectatorRelay) === null);

  let floodRelayed = 0;
  const count = () => floodRelayed++;
  bobSocket.on('opponent:camera', count);
  const floodError = waitFor(aliceSocket, 'error', 1_200);
  for (let i = 0; i < 60; i++) aliceSocket.emit('solve:camera', POSE);
  check('ยิงรวด 60 ครั้ง → ไม่มี error กลับ (ส่วนที่เกินทิ้งเงียบ)', (await floodError) === null);
  bobSocket.off('opponent:camera', count);
  if (floodRelayed === 60) {
    console.log('  ⏭️  ส่งต่อครบ 60 — server นี้ปิด rate limit อยู่ (DISABLE_RATE_LIMIT) ข้ามเช็คโควตา');
  } else {
    check(
      'ส่งต่อไม่เกินโควตา 30 ครั้ง/วินาที',
      floodRelayed > 0 && floodRelayed <= 30,
      floodRelayed,
    );
  }

  // ---------------------------------------------------------------- SOLVING
  console.log('\nSOLVING');
  if (!(await solving)) throw new Error('ไม่ได้เข้า SOLVING');
  const toAlice = waitFor<Relayed>(aliceSocket, 'opponent:camera', 2_000);
  bobSocket.emit('solve:camera', { q: [0, 0, 0, 1], d: 4 });
  check('ช่วงจับเวลา → ส่งต่อได้ (อีกฝั่งส่งมา)', (await toAlice)?.userId === bob.userId);

  // ---------------------------------------------------------------- จบแมตช์
  const finished = waitFor(aliceSocket, 'match:finished');
  await emit(aliceSocket, 'solve:surrender', {});
  await emit(bobSocket, 'solve:surrender', {});
  await finished;

  console.log('\nFINISHED');
  const afterRelay = waitFor(bobSocket, 'opponent:camera', 800);
  aliceSocket.emit('solve:camera', POSE);
  check('จบแมตช์แล้ว → ไม่ส่งต่อ', (await afterRelay) === null);

  for (const socket of [aliceSocket, bobSocket, eveSocket]) {
    await emit(socket, 'room:leave', {});
    socket.disconnect();
  }
  process.exitCode = summary();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
