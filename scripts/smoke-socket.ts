/**
 * ทดสอบวงจรชีวิตของห้องผ่าน Socket.IO จริง ๆ (เฟส 4 ก้อนที่ 1)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * รันด้วย: npx tsx scripts/smoke-socket.ts
 *
 * ครอบ: handshake · net:ping · create/join ด้วยรหัสห้อง · ready · ผู้ชม ·
 *       เข้าห้องเดิมด้วย socket ใหม่ (rejoin) · ออกจากห้อง · การโอน host · เคส error
 */
import { io, type Socket } from 'socket.io-client';

const SERVER_URL = process.env.SMOKE_SERVER_URL ?? 'http://localhost:4000';
const API = `${SERVER_URL}/api/v1`;
const SEED_PASSWORD = 'Password123!';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`, detail === undefined ? '' : detail);
  }
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password: SEED_PASSWORD }),
  });
  const body = (await res.json()) as { data?: { accessToken: string }; error?: unknown };
  if (!res.ok || !body.data)
    throw new Error(`เข้าสู่ระบบ ${identifier} ไม่ผ่าน: ${JSON.stringify(body)}`);
  return body.data.accessToken;
}

type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function connect(token: string): Promise<Socket> {
  const socket = io(SERVER_URL, { auth: { token }, transports: ['websocket'] });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emit<T>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/** รอ event หนึ่งตัว ไม่มาภายในเวลาที่กำหนดถือว่าไม่ผ่าน */
function waitFor<T>(socket: Socket, event: string, timeoutMs = 1_500): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      resolve(null);
    }, timeoutMs);
    const listener = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

interface Snapshot {
  roomId: number;
  roomCode: string | null;
  state: string;
  cubeType: string;
  players: { userId: number; username: string; isHost: boolean; isReady: boolean }[];
  spectatorCount: number;
  scramble: string | null;
}

async function main(): Promise<void> {
  console.log(`\n🔌 ทดสอบ Socket.IO ที่ ${SERVER_URL}\n`);

  // ---------------------------------------------------------------- handshake
  console.log('handshake');
  const noToken = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
  const connectError = await new Promise<Error & { data?: { code?: string } }>((resolve) => {
    noToken.once('connect_error', resolve);
  });
  check(
    'ไม่แนบ token → ต่อไม่ได้ (E_UNAUTHENTICATED)',
    connectError.data?.code === 'E_UNAUTHENTICATED',
    connectError.data,
  );
  noToken.close();

  const badToken = io(SERVER_URL, {
    auth: { token: 'not-a-real-token' },
    transports: ['websocket'],
    reconnection: false,
  });
  const badError = await new Promise<Error & { data?: { code?: string } }>((resolve) => {
    badToken.once('connect_error', resolve);
  });
  check('token ปลอม → ต่อไม่ได้', badError.data?.code === 'E_UNAUTHENTICATED', badError.data);
  badToken.close();

  const [tokenA, tokenB, tokenC] = await Promise.all([
    login('somchai'),
    login('malee'),
    login('nattapong'),
  ]);
  const alice = await connect(tokenA);
  const bob = await connect(tokenB);
  check('ต่อด้วย token ที่ถูกต้องได้', alice.connected && bob.connected);

  // ---------------------------------------------------------------- net:ping
  console.log('\nnet:ping');
  const clientTs = Date.now();
  const pong = await emit<{ serverTs: number; clientTs: number }>(alice, 'net:ping', { clientTs });
  check(
    'ack กลับมาพร้อม serverTs และ clientTs เดิม',
    pong.ok && pong.data.clientTs === clientTs && pong.data.serverTs > 0,
    pong,
  );
  const pong2 = await emit(alice, 'net:ping', { clientTs: Date.now(), lastRttMs: 42 });
  check('รายงาน lastRttMs ได้', pong2.ok, pong2);
  const badPing = await emit(alice, 'net:ping', { clientTs: 'ไม่ใช่ตัวเลข' });
  check(
    'payload ผิดชนิด → E_VALIDATION',
    !badPing.ok && badPing.error.code === 'E_VALIDATION',
    badPing,
  );

  // ---------------------------------------------------------------- สร้าง/เข้าห้อง
  console.log('\nroom:create / room:join');
  /**
   * ชนิดห้องกับจำนวนคนต้องเข้าคู่กัน — ตรวจสองฟิลด์พร้อมกัน (เฟส 6 ก้อนที่ 1)
   * เช็คแค่คู่ที่ผิดเสมอ ไม่ว่าสวิตช์ทดสอบ `ALLOW_TEST_COMPETITIVE_ROOM` จะเปิดหรือปิด
   */
  const badSize = await emit(alice, 'room:create', {
    cubeType: '3x3x3',
    kind: 'custom',
    maxPlayers: 4,
  });
  check(
    'ห้องสร้างเอง 1v1 ขอ 4 คน → E_VALIDATION',
    !badSize.ok && badSize.error.code === 'E_VALIDATION',
    badSize,
  );

  const badMultiSize = await emit(alice, 'room:create', {
    cubeType: '3x3x3',
    kind: 'multiplayer',
    maxPlayers: 2,
  });
  check(
    'ห้องผู้เล่นหลายคนขอ 2 คน → E_VALIDATION',
    !badMultiSize.ok && badMultiSize.error.code === 'E_VALIDATION',
    badMultiSize,
  );

  const badRoomMode = await emit(alice, 'room:create', {
    cubeType: '3x3x3',
    kind: 'custom',
    maxPlayers: 2,
    roomMode: 'auto',
  });
  check(
    'ระบุ roomMode เองในห้อง 1v1 ไม่ได้ (โหมด auto มาจากคิวเท่านั้น) → E_VALIDATION',
    !badRoomMode.ok && badRoomMode.error.code === 'E_VALIDATION',
    badRoomMode,
  );

  const created = await emit<{ roomId: number; roomCode: string }>(alice, 'room:create', {
    cubeType: '3x3x3',
    kind: 'custom',
    maxPlayers: 2,
  });
  check('สร้างห้องได้', created.ok, created);
  if (!created.ok) throw new Error('สร้างห้องไม่ผ่าน หยุดทดสอบ');
  const { roomId, roomCode } = created.data;
  check('รหัสห้อง 6 หลัก ไม่มี 0/O/1/I', /^[A-HJ-NP-Z2-9]{6}$/.test(roomCode), roomCode);

  const notFound = await emit(bob, 'room:join', { roomCode: 'ZZZZZZ', as: 'player' });
  check(
    'รหัสห้องผิด → E_ROOM_NOT_FOUND',
    !notFound.ok && notFound.error.code === 'E_ROOM_NOT_FOUND',
    notFound,
  );

  const aliceJoined = waitFor<{ player: { username: string } }>(alice, 'room:player_joined');
  const joined = await emit<{ snapshot: Snapshot }>(bob, 'room:join', {
    // ตั้งใจส่งตัวพิมพ์เล็ก — schema ต้องแปลงให้เอง
    roomCode: roomCode.toLowerCase(),
    as: 'player',
  });
  check('เข้าห้องด้วยรหัส (พิมพ์เล็กก็ได้)', joined.ok, joined);
  const joinEvent = await aliceJoined;
  check('เจ้าของห้องได้รับ room:player_joined', joinEvent?.player.username === 'malee', joinEvent);

  if (joined.ok) {
    const snap = joined.data.snapshot;
    check('ห้องมีผู้เล่น 2 คน', snap.players.length === 2, snap.players);
    check(
      'คนสร้างห้องเป็น host',
      snap.players[0]?.isHost === true && snap.players[1]?.isHost === false,
      snap.players,
    );
    check('state ยังเป็น WAITING', snap.state === 'WAITING', snap.state);
    check('ยังไม่เปิดเผย scramble ก่อนเริ่ม', snap.scramble === null, snap.scramble);
  }

  const carol = await connect(tokenC);
  const full = await emit(carol, 'room:join', { roomCode, as: 'player' });
  check(
    'ห้องเต็มแล้วเข้าเป็นผู้เล่นไม่ได้ → E_ROOM_FULL',
    !full.ok && full.error.code === 'E_ROOM_FULL',
    full,
  );

  // ---------------------------------------------------------------- ready
  console.log('\nroom:ready');
  const readyEvent = waitFor<{ userId: number; ready: boolean }>(alice, 'room:ready_changed');
  const ready = await emit(bob, 'room:ready', { ready: true });
  check('กดพร้อมได้', ready.ok, ready);
  const readyBroadcast = await readyEvent;
  check('อีกฝ่ายเห็น room:ready_changed', readyBroadcast?.ready === true, readyBroadcast);

  // ---------------------------------------------------------------- ผู้ชม
  console.log('\nผู้ชม (spectator)');
  const countEvent = waitFor<{ count: number }>(alice, 'room:spectator_count');
  const spectate = await emit<{ snapshot: Snapshot }>(carol, 'room:join', {
    roomCode,
    as: 'spectator',
  });
  check('เข้าดูในฐานะผู้ชมได้', spectate.ok, spectate);
  const count = await countEvent;
  check('ผู้เล่นเห็นจำนวนผู้ชมเปลี่ยนเป็น 1', count?.count === 1, count);

  // ---------------------------------------------------------------- reconnect
  console.log('\nreconnect (room:rejoin)');
  bob.close();
  await new Promise((r) => setTimeout(r, 200));
  const bob2 = await connect(tokenB);
  const rejoined = await emit<{ snapshot: Snapshot }>(bob2, 'room:rejoin', { roomId });
  check('socket ใหม่กลับเข้าที่นั่งเดิมได้', rejoined.ok, rejoined);
  if (rejoined.ok) {
    const me = rejoined.data.snapshot.players.find((p) => p.username === 'malee');
    check('สถานะ "พร้อม" ที่กดไว้ยังอยู่', me?.isReady === true, me);
  }
  const rejoinOther = await emit(carol, 'room:rejoin', { roomId: 999_999 });
  check(
    'rejoin ห้องที่ไม่มี → E_ROOM_NOT_FOUND',
    !rejoinOther.ok && rejoinOther.error.code === 'E_ROOM_NOT_FOUND',
    rejoinOther,
  );

  // ---------------------------------------------------------------- ออกจากห้อง + โอน host
  console.log('\nroom:leave + โอน host');
  // ต้องดักทั้งสอง event ก่อนสั่ง ไม่งั้น event มาถึงก่อนที่จะติดตัวดัก
  const hostChanged = waitFor<{ newHostUserId: number }>(bob2, 'room:host_changed');
  const stateAfter = waitFor<Snapshot>(bob2, 'room:state');
  const left = await emit(alice, 'room:leave', {});
  check('host ออกจากห้องได้', left.ok, left);
  const newHost = await hostChanged;
  check('โอน host ให้ผู้เล่นที่เหลือ', newHost !== null, newHost);
  const snapshotAfter = await stateAfter;
  check('ห้องเหลือผู้เล่น 1 คน', snapshotAfter?.players.length === 1, snapshotAfter?.players);

  const aborted = waitFor<{ reason: string }>(carol, 'room:aborted');
  await emit(bob2, 'room:leave', {});
  const abortEvent = await aborted;
  check(
    'ไม่เหลือผู้เล่น → ห้องถูกยุบ แจ้งผู้ชมด้วย',
    abortEvent?.reason === 'host_left',
    abortEvent,
  );

  const gone = await emit(carol, 'room:join', { roomCode, as: 'spectator' });
  check('ห้องที่ยุบแล้วเข้าไม่ได้อีก', !gone.ok && gone.error.code === 'E_ROOM_NOT_FOUND', gone);

  // ---------------------------------------------------------------- หลายแท็บของคนเดียวกัน
  console.log('\nเปิดหลายแท็บ (คนเดียวกัน = ที่นั่งเดียว)');
  const room2 = await emit<{ roomId: number; roomCode: string }>(alice, 'room:create', {
    cubeType: '2x2x2',
    kind: 'custom',
    maxPlayers: 2,
  });
  if (!room2.ok) throw new Error('สร้างห้องที่สองไม่ผ่าน');
  await emit(bob2, 'room:join', { roomCode: room2.data.roomCode, as: 'player' });

  const aliceTab2 = await connect(tokenA);
  const sameSeat = await emit<{ snapshot: Snapshot }>(aliceTab2, 'room:rejoin', {
    roomId: room2.data.roomId,
  });
  check(
    'แท็บที่สองเข้าห้องเดิมแล้วยังนับเป็นผู้เล่นคนเดียว',
    sameSeat.ok && sameSeat.data.snapshot.players.length === 2,
    sameSeat,
  );

  // แท็บที่สองไปสร้างห้องใหม่ — ที่นั่งในห้องเดิมต้องหายไปทั้งคน ไม่ทิ้ง "ผู้เล่นผี" ไว้
  const ghostLeft = waitFor<{ userId: number }>(bob2, 'room:player_left');
  const room3 = await emit(aliceTab2, 'room:create', {
    cubeType: '3x3x3',
    kind: 'custom',
    maxPlayers: 2,
  });
  check('แท็บที่สองสร้างห้องใหม่ได้', room3.ok, room3);
  check('ห้องเดิมเอาคนนั้นออกทั้งคน (ไม่เหลือผู้เล่นผี)', (await ghostLeft) !== null);

  const afterGhost = await emit<{ snapshot: Snapshot }>(bob2, 'room:rejoin', {
    roomId: room2.data.roomId,
  });
  check(
    'ห้องเดิมเหลือผู้เล่น 1 คนและได้ host ใหม่',
    afterGhost.ok &&
      afterGhost.data.snapshot.players.length === 1 &&
      afterGhost.data.snapshot.players[0]?.isHost === true,
    afterGhost.ok ? afterGhost.data.snapshot.players : afterGhost,
  );

  for (const socket of [alice, bob2, carol, aliceTab2]) socket.close();

  console.log(`\nสรุป: ผ่าน ${passed} · ไม่ผ่าน ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('\n💥 ทดสอบล้ม:', error);
  process.exit(1);
});
