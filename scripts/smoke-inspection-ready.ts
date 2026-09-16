/**
 * ปุ่ม "พร้อม" ช่วง inspection — พร้อมครบทุกคน = จบก่อนเวลา +3 วินาที (เฟส 13 ก้อนที่ 9 · ADR-078)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว
 * รันด้วย: npm run smoke:inspection-ready     (~40 วินาที — มีช่วงที่ต้องรอ inspection ครบ 15 วินาทีจริงหนึ่งรอบ)
 * ⚠️ รันพร้อมสโมคเทสตัวอื่นไม่ได้ — ใช้บัญชี seed ชุดเดียวกัน login แล้วเตะกันเอง (ADR-076)
 *
 * ครอบ: นอก INSPECTION / ผู้ชม → E_INVALID_STATE · พร้อมคนเดียวไม่เริ่ม · ส่งค่าเดิมซ้ำไม่ broadcast ·
 *       ยกเลิกได้ · พร้อมครบ → `match:inspection_shortened` ≈ +3 วินาที · หลังล็อกยกเลิกไม่ได้ ·
 *       ช่วง buffer ยังหมุนไม่ได้ · ล้างค่าพร้อมทุกรอบ · หลุดก่อนครบ = ล้างพร้อม · กลับมากดใหม่ได้ ·
 *       ห้องหลายคนต้องครบทั้ง 3 คน
 */
import type { Socket } from 'socket.io-client';
import { check, connect, emit, login, SERVER_URL, summary, waitFor } from './smoke-helpers.js';

const CUBE_TYPE = '2x2x2';
const BUFFER_MS = 3_000;

interface PlayerView {
  userId: number;
  inspectionReady: boolean;
}
interface Snapshot {
  state: string;
  phaseEndsAtTs: number | null;
  serverStartTs: number | null;
  players: PlayerView[];
}
interface ReadyAck {
  readyCount: number;
  playerCount: number;
}

/** เก็บ `room:state` ใบล่าสุดของ socket นี้ไว้อ่านทีหลัง */
function trackState(socket: Socket): () => Snapshot | null {
  let latest: Snapshot | null = null;
  socket.on('room:state', (snapshot: Snapshot) => (latest = snapshot));
  return () => latest;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readyOf(snapshot: Snapshot | null, userId: number): boolean | undefined {
  return snapshot?.players.find((player) => player.userId === userId)?.inspectionReady;
}

/** host กดเริ่ม → ทุกคนแจ้งโหลดเสร็จ → รอเข้า INSPECTION · คืน payload ของ inspection */
async function enterInspection(host: Socket, sockets: Socket[]): Promise<{ endsAtTs: number }> {
  const loading = waitFor(host, 'match:loading');
  const started = await emit(host, 'room:start', {});
  if (!started.ok)
    throw new Error(`กดเริ่มไม่ผ่าน: ${started.error.code} ${started.error.message}`);
  if (!(await loading)) throw new Error('ไม่ได้รับ match:loading');

  const inspection = waitFor<{ endsAtTs: number }>(host, 'match:inspection_started');
  for (const socket of sockets) await emit(socket, 'solve:ready', {});
  const payload = await inspection;
  if (!payload) throw new Error('ไม่ได้เข้า INSPECTION');
  return payload;
}

/** ยอมแพ้ทุกคนให้รอบจบเร็ว ๆ */
async function surrenderAll(sockets: Socket[]): Promise<void> {
  const finished = waitFor(sockets[0]!, 'match:finished');
  for (const socket of sockets) await emit(socket, 'solve:surrender', {});
  if (!(await finished)) throw new Error('รอบไม่จบหลังยอมแพ้ครบ');
}

async function duel(): Promise<void> {
  const [alice, bob, eve] = await Promise.all([
    login('somchai'),
    login('malee'),
    login('nattapong'),
  ]);
  const aliceSocket = await connect(alice.token);
  let bobSocket = await connect(bob.token);
  const eveSocket = await connect(eve.token);
  const aliceState = trackState(aliceSocket);

  const created = await emit<{ roomId: number; roomCode: string }>(aliceSocket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'custom',
    maxPlayers: 2,
  });
  if (!created.ok) throw new Error(`สร้างห้องไม่ผ่าน: ${created.error.code}`);
  const { roomId, roomCode } = created.data;
  await emit(bobSocket, 'room:join', { roomCode, as: 'player' });
  const watching = await emit(eveSocket, 'room:join', { roomCode, as: 'spectator' });
  if (!watching.ok) throw new Error(`เข้าเป็นผู้ชมไม่ผ่าน: ${watching.error.code}`);

  // ---------------------------------------------------------------- นอกช่วง
  console.log('ห้อง 1v1 — นอกช่วง INSPECTION');
  const lobby = await emit(aliceSocket, 'solve:inspection_ready', { ready: true });
  check(
    'กดพร้อมตอน WAITING → E_INVALID_STATE',
    !lobby.ok && lobby.error.code === 'E_INVALID_STATE',
    lobby,
  );

  // ---------------------------------------------------------------- รอบที่ 1
  console.log('\nรอบที่ 1 — กด/ยกเลิก/พร้อมครบ');
  const inspection = await enterInspection(aliceSocket, [aliceSocket, bobSocket]);
  await sleep(100);
  check(
    'เข้า INSPECTION แล้วทุกคนยังไม่พร้อม (inspectionReady: false)',
    readyOf(aliceState(), alice.userId) === false && readyOf(aliceState(), bob.userId) === false,
    aliceState()?.players,
  );

  const spectator = await emit(eveSocket, 'solve:inspection_ready', { ready: true });
  check(
    'ผู้ชมกดพร้อม → E_INVALID_STATE',
    !spectator.ok && spectator.error.code === 'E_INVALID_STATE',
    spectator,
  );

  const bobSees = waitFor<{ userId: number; ready: boolean }>(
    bobSocket,
    'player:inspection_ready',
    2_000,
  );
  const aliceReady = await emit<ReadyAck>(aliceSocket, 'solve:inspection_ready', { ready: true });
  check(
    'กดพร้อม → ack { readyCount: 1, playerCount: 2 }',
    aliceReady.ok && aliceReady.data.readyCount === 1 && aliceReady.data.playerCount === 2,
    aliceReady,
  );
  const seen = await bobSees;
  check(
    'อีกฝ่ายได้ player:inspection_ready ของคนที่กด',
    seen?.userId === alice.userId && seen.ready === true,
    seen,
  );
  await sleep(100);
  check('snapshot บอกว่าคนที่กดพร้อมแล้ว', readyOf(aliceState(), alice.userId) === true);

  const noRebroadcast = waitFor(bobSocket, 'player:inspection_ready', 600);
  const again = await emit<ReadyAck>(aliceSocket, 'solve:inspection_ready', { ready: true });
  check('ส่งค่าเดิมซ้ำไม่ใช่ error', again.ok && again.data.readyCount === 1, again);
  check('… และไม่ broadcast ซ้ำ', (await noRebroadcast) === null);

  const cancel = await emit<ReadyAck>(aliceSocket, 'solve:inspection_ready', { ready: false });
  check('ยกเลิกพร้อมได้ → readyCount 0', cancel.ok && cancel.data.readyCount === 0, cancel);

  const shortenedEarly = waitFor(aliceSocket, 'match:inspection_shortened', 1_500);
  const startedEarly = waitFor(aliceSocket, 'match:started', 1_500);
  await emit(aliceSocket, 'solve:inspection_ready', { ready: true });
  check('พร้อมคนเดียว → ไม่ย่นเวลา', (await shortenedEarly) === null);
  check('… และยังไม่เริ่มจับเวลา', (await startedEarly) === null);

  const shortened = waitFor<{ endsAtTs: number }>(aliceSocket, 'match:inspection_shortened', 2_000);
  const bobShortened = waitFor<{ endsAtTs: number }>(
    bobSocket,
    'match:inspection_shortened',
    2_000,
  );
  const eveShortened = waitFor<{ endsAtTs: number }>(
    eveSocket,
    'match:inspection_shortened',
    2_000,
  );
  const started = waitFor<{ serverStartTs: number }>(
    aliceSocket,
    'match:started',
    BUFFER_MS + 3_000,
  );
  const lockedAt = Date.now();
  const bobReady = await emit<ReadyAck>(bobSocket, 'solve:inspection_ready', { ready: true });
  check(
    'คนสุดท้ายกดพร้อม → ack { readyCount: 2, playerCount: 2 }',
    bobReady.ok && bobReady.data.readyCount === 2,
    bobReady,
  );
  const shortPayload = await shortened;
  const lead = shortPayload ? shortPayload.endsAtTs - lockedAt : null;
  check(
    `พร้อมครบ → match:inspection_shortened ที่ endsAtTs ≈ ตอนนี้ + ${BUFFER_MS} ms (ไม่ใช่ทันที)`,
    lead !== null && lead > BUFFER_MS - 300 && lead <= BUFFER_MS + 50,
    { lead },
  );
  check(
    'endsAtTs ใหม่มาก่อนเวลาเดิม',
    shortPayload !== null && shortPayload.endsAtTs < inspection.endsAtTs,
  );
  const [bobShort, eveShort] = await Promise.all([bobShortened, eveShortened]);
  check(
    'อีกฝ่าย + ผู้ชมได้เวลาใหม่ชุดเดียวกัน',
    bobShort?.endsAtTs === shortPayload?.endsAtTs && eveShort?.endsAtTs === shortPayload?.endsAtTs,
  );
  await sleep(50);
  const lockedSnap = aliceState();
  check(
    'snapshot: phaseEndsAtTs = เวลาใหม่ · state ยังเป็น INSPECTION · ทุกคน inspectionReady',
    lockedSnap?.state === 'INSPECTION' &&
      lockedSnap.phaseEndsAtTs === shortPayload?.endsAtTs &&
      lockedSnap.players.every((player) => player.inspectionReady),
    lockedSnap,
  );

  const afterLock = await emit(aliceSocket, 'solve:inspection_ready', { ready: false });
  check(
    'หลังพร้อมครบแล้วยกเลิกไม่ได้ → E_INVALID_STATE',
    !afterLock.ok && afterLock.error.code === 'E_INVALID_STATE',
    afterLock,
  );

  const bufferMove = waitFor<{ code: string }>(bobSocket, 'error', 500);
  bobSocket.emit('solve:move', { seq: 1, move: 'R', clientTs: Date.now() });
  check(
    'ช่วง buffer 3 วินาทียังหมุนไม่ได้ → E_MOVE_DURING_INSPECTION',
    (await bufferMove)?.code === 'E_MOVE_DURING_INSPECTION',
  );

  const startedPayload = await started;
  check(
    'match:started มาหลัง endsAtTs ใหม่ และก่อนเวลาเดิมของ inspection',
    startedPayload !== null &&
      shortPayload !== null &&
      startedPayload.serverStartTs >= shortPayload.endsAtTs &&
      startedPayload.serverStartTs < inspection.endsAtTs,
    { startedPayload, shortPayload, original: inspection.endsAtTs },
  );

  await surrenderAll([aliceSocket, bobSocket]);

  // ---------------------------------------------------------------- รอบที่ 2
  console.log('\nรอบที่ 2 (เล่นอีกครั้งในห้องเดิม) — ค่าพร้อมล้าง · หลุดก่อนครบ');
  const second = await enterInspection(aliceSocket, [aliceSocket, bobSocket]);
  await sleep(100);
  check(
    'รอบใหม่ค่าพร้อมของรอบก่อนไม่ติดมา',
    readyOf(aliceState(), alice.userId) === false && readyOf(aliceState(), bob.userId) === false,
    aliceState()?.players,
  );

  await emit(bobSocket, 'solve:inspection_ready', { ready: true });
  const cleared = waitFor<{ userId: number; ready: boolean }>(
    aliceSocket,
    'player:inspection_ready',
    3_000,
  );
  bobSocket.disconnect();
  const clearedPayload = await cleared;
  check(
    'คนที่พร้อมแล้วหลุด → server ล้างพร้อมให้ (player:inspection_ready ready: false)',
    clearedPayload?.userId === bob.userId && clearedPayload.ready === false,
    clearedPayload,
  );

  const noShortWhileAway = waitFor(aliceSocket, 'match:inspection_shortened', 1_200);
  await emit(aliceSocket, 'solve:inspection_ready', { ready: true });
  check('อีกฝ่ายหลุดอยู่ → กดพร้อมคนเดียวไม่ย่นเวลา', (await noShortWhileAway) === null);

  bobSocket = await connect(bob.token);
  const bobState = trackState(bobSocket);
  const rejoined = await emit<{ snapshot: Snapshot }>(bobSocket, 'room:rejoin', { roomId });
  check(
    'กลับเข้าห้องแล้ว snapshot บอกว่าตัวเองยังไม่พร้อม (ต้องกดใหม่)',
    rejoined.ok && readyOf(rejoined.data.snapshot, bob.userId) === false,
    rejoined,
  );

  const reShort = waitFor<{ endsAtTs: number }>(aliceSocket, 'match:inspection_shortened', 2_000);
  await emit(bobSocket, 'solve:inspection_ready', { ready: true });
  const reShortPayload = await reShort;
  check(
    'กลับมากดพร้อมใหม่ → พร้อมครบ → ย่นเวลาได้',
    reShortPayload !== null && reShortPayload.endsAtTs < second.endsAtTs,
    reShortPayload,
  );
  await waitFor(aliceSocket, 'match:started', BUFFER_MS + 3_000);
  check('ผู้เล่นที่กลับมาเห็นเวลาเริ่มจาก snapshot ด้วย', bobState() !== null);

  await surrenderAll([aliceSocket, bobSocket]);
  await emit(eveSocket, 'room:leave', {});
  await emit(bobSocket, 'room:leave', {});
  await emit(aliceSocket, 'room:leave', {});
  for (const socket of [aliceSocket, bobSocket, eveSocket]) socket.disconnect();
}

async function multiplayer(): Promise<void> {
  console.log('\nห้องหลายคน 3 คน — ต้องพร้อมครบทุกคน');
  const auths = await Promise.all([login('somchai'), login('malee'), login('nattapong')]);
  const sockets = await Promise.all(auths.map((auth) => connect(auth.token)));
  const [host, second, third] = sockets as [Socket, Socket, Socket];

  const created = await emit<{ roomCode: string }>(host, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'multiplayer',
    maxPlayers: 3,
  });
  if (!created.ok) throw new Error(`สร้างห้องหลายคนไม่ผ่าน: ${created.error.code}`);
  for (const socket of [second, third]) {
    await emit(socket, 'room:join', { roomCode: created.data.roomCode, as: 'player' });
  }

  const inspection = await enterInspection(host, sockets);

  const notYet = waitFor(host, 'match:inspection_shortened', 1_200);
  await emit(host, 'solve:inspection_ready', { ready: true });
  const two = await emit<ReadyAck>(second, 'solve:inspection_ready', { ready: true });
  check(
    'พร้อม 2 จาก 3 → ack { readyCount: 2, playerCount: 3 }',
    two.ok && two.data.readyCount === 2 && two.data.playerCount === 3,
    two,
  );
  check('… ยังไม่ย่นเวลา', (await notYet) === null);

  const shortened = waitFor<{ endsAtTs: number }>(host, 'match:inspection_shortened', 2_000);
  await emit(third, 'solve:inspection_ready', { ready: true });
  const payload = await shortened;
  check('ครบ 3 คน → ย่นเวลา', payload !== null && payload.endsAtTs < inspection.endsAtTs, payload);
  check('เริ่มจับเวลาได้จริง', (await waitFor(host, 'match:started', BUFFER_MS + 3_000)) !== null);

  await surrenderAll(sockets);
  for (const socket of sockets) await emit(socket, 'room:leave', {});
  for (const socket of sockets) socket.disconnect();
}

async function main(): Promise<void> {
  console.log(`\n✋ ทดสอบปุ่มพร้อมช่วง inspection ที่ ${SERVER_URL} (${CUBE_TYPE})\n`);
  await duel();
  await multiplayer();
  process.exit(summary());
}

main().catch((error: unknown) => {
  console.error('\n💥 สโมคเทสล้ม:', error);
  process.exit(1);
});
