/**
 * สลับผู้เล่น ↔ ผู้ชม + สิทธิ์หัวห้องผูกกับการอยู่ในห้อง (เฟส 13 ก้อนที่ 14 · ADR-082)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว
 * รันด้วย: npm run smoke:switch-seat     (~1 นาที — ย่น inspection ด้วยปุ่มพร้อม · รอคิวจับคู่สูงสุด 35 วินาที)
 * ⚠️ รันพร้อมสโมคเทสตัวอื่นไม่ได้ — ใช้บัญชี seed ชุดเดียวกัน login แล้วเตะกันเอง (ADR-076)
 * ⚠️ ส่วนท้าย (ห้องจากคิว) ปล่อย `kanyarat` / `supachai` ค้างในห้องที่กำลังโหลด ~30 วินาทีจนหมด grace
 *    — รันซ้ำทันทีส่วนนั้นจะตก ("ยังอยู่ในห้องที่กำลังแข่งอยู่") · ไม่บันทึก DB ไม่แตะ Elo
 *
 * ครอบ: ที่นั่งเดิม = ตอบ snapshot ไม่ broadcast · payload ผิด · หัวห้องไปเป็นผู้ชมแล้วห้องไม่ยุบ/สิทธิ์ไม่หลุด ·
 *       ไม่ส่ง room:player_left · ย้ายครบทุกแท็บ · ที่นั่งเต็ม → E_ROOM_FULL · หัวห้องที่เป็นผู้ชมกดเริ่มได้ ·
 *       ผู้ชมกด room:ready ไม่ได้ · ระหว่างแข่งสลับไม่ได้ · ผู้ชม(หัวห้อง)ได้ opponent:move ·
 *       ผู้ชมสลับมาเป็นผู้เล่นแล้วหมุน/กดพร้อมได้ · ผู้เล่นที่ไปเป็นผู้ชมยอมแพ้ไม่ได้ ·
 *       ลำดับโอนหัวห้อง ผู้เล่นคนแรก → ผู้ชมคนแรก → ยุบ · ผู้ชมปิดแท็บ = โอนทันที ·
 *       room:join คนละที่นั่งในห้องเดิม = สลับ (ไม่ซ้อนสองฝั่ง) · ห้อง 3 คน · ห้องจากคิวใช้ไม่ได้
 */
import type { Socket } from 'socket.io-client';
import {
  autoAcceptMatches,
  check,
  connect,
  emit,
  login,
  SERVER_URL,
  summary,
  waitFor,
} from './smoke-helpers.js';

const CUBE_TYPE = '2x2x2';

interface Host {
  userId: number;
  username: string;
  seat: 'player' | 'spectator';
}
interface Snapshot {
  roomId: number;
  state: string;
  players: { userId: number; isHost: boolean; isReady: boolean }[];
  spectatorCount: number;
  host: Host | null;
}
type SnapshotAck = { snapshot: Snapshot };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** เก็บ `room:state` ใบล่าสุดของ socket นี้ไว้อ่านทีหลัง */
function trackState(socket: Socket): () => Snapshot | null {
  let latest: Snapshot | null = null;
  socket.on('room:state', (snapshot: Snapshot) => (latest = snapshot));
  return () => latest;
}

function isError(ack: { ok: boolean; error?: { code: string } }, code: string): boolean {
  return !ack.ok && ack.error?.code === code;
}

/**
 * host กดเริ่ม → ผู้เล่นแจ้งโหลดเสร็จ → เข้า INSPECTION → กดพร้อมครบ → รอเริ่มจับเวลา (~3 วินาที)
 * `watcher` = socket ที่ใช้ดัก event (ผู้ชมก็ได้ เพราะได้ event ชุดเดียวกัน)
 */
async function playUntilSolving(host: Socket, players: Socket[], watcher: Socket): Promise<void> {
  const loading = waitFor(watcher, 'match:loading', 10_000);
  const started = await emit(host, 'room:start', {});
  if (!started.ok) {
    throw new Error(`กดเริ่มไม่ผ่าน: ${started.error.code} ${started.error.message}`);
  }
  if (!(await loading)) throw new Error('ไม่ได้รับ match:loading');

  const inspection = waitFor(watcher, 'match:inspection_started', 10_000);
  for (const socket of players) await emit(socket, 'solve:ready', {});
  if (!(await inspection)) throw new Error('ไม่ได้เข้า INSPECTION');

  const solving = waitFor(watcher, 'match:started', 8_000);
  for (const socket of players) await emit(socket, 'solve:inspection_ready', { ready: true });
  if (!(await solving)) throw new Error('ไม่ได้เริ่มจับเวลา');
}

async function surrenderAll(players: Socket[], watcher: Socket): Promise<void> {
  const finished = waitFor(watcher, 'match:finished', 10_000);
  for (const socket of players) await emit(socket, 'solve:surrender', {});
  if (!(await finished)) throw new Error('รอบไม่จบหลังยอมแพ้ครบ');
}

// ---------------------------------------------------------------- ห้อง 1v1

async function duel(): Promise<void> {
  const [alice, bob, eve, dan] = await Promise.all([
    login('somchai'),
    login('malee'),
    login('nattapong'),
    login('pimchanok'),
  ]);
  const aliceSocket = await connect(alice.token);
  const aliceTab2 = await connect(alice.token);
  const bobSocket = await connect(bob.token);
  const eveSocket = await connect(eve.token);
  let danSocket = await connect(dan.token);
  const tab2State = trackState(aliceTab2);

  const created = await emit<{ roomId: number; roomCode: string }>(aliceSocket, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'custom',
    maxPlayers: 2,
  });
  if (!created.ok) throw new Error(`สร้างห้องไม่ผ่าน: ${created.error.code}`);
  const { roomId, roomCode } = created.data;
  await emit(aliceTab2, 'room:rejoin', { roomId });

  // ---------------------------------------------------------------- ตรวจ payload / ที่นั่งเดิม
  console.log('ห้อง 1v1 — ที่นั่งเดิม · payload ผิด');
  const bad = await emit(aliceSocket, 'room:switch_seat', { to: 'host' });
  check('to ผิดค่า → E_VALIDATION', isError(bad, 'E_VALIDATION'), bad);

  const noBroadcast = waitFor(aliceTab2, 'room:state', 600);
  const same = await emit<SnapshotAck>(aliceSocket, 'room:switch_seat', { to: 'player' });
  check(
    'สลับไปที่นั่งเดิม → ตอบ snapshot ปกติ',
    same.ok && same.data.snapshot.players.length === 1,
    same,
  );
  check('… และไม่ broadcast room:state', (await noBroadcast) === null);

  // ---------------------------------------------------------------- หัวห้องไปเป็นผู้ชม
  console.log('\nหัวห้องย้ายไปเป็นผู้ชม (อยู่คนเดียวในห้อง)');
  const noLeftEvent = waitFor(aliceTab2, 'room:player_left', 700);
  const noAbort = waitFor(aliceTab2, 'room:aborted', 700);
  const toSpectator = await emit<SnapshotAck>(aliceSocket, 'room:switch_seat', {
    to: 'spectator',
  });
  const snap = toSpectator.ok ? toSpectator.data.snapshot : null;
  check(
    'สลับเป็นผู้ชมได้ → ผู้เล่น 0 · ผู้ชม 1',
    snap?.players.length === 0 && snap.spectatorCount === 1,
    toSpectator,
  );
  check(
    'host ยังเป็นคนเดิม · seat: spectator',
    snap?.host?.userId === alice.userId && snap.host.seat === 'spectator',
    snap?.host,
  );
  check('ห้องไม่ถูกยุบ (ไม่มี room:aborted)', (await noAbort) === null);
  check('ไม่ส่ง room:player_left (client จะนึกว่าถูกพาออก)', (await noLeftEvent) === null);
  await sleep(100);
  check(
    'แท็บที่สองของหัวห้องได้ room:state ใหม่ด้วย',
    tab2State()?.host?.seat === 'spectator',
    tab2State()?.host,
  );

  const readyAsSpectator = await emit(aliceSocket, 'room:ready', { ready: true });
  check(
    'หัวห้องที่เป็นผู้ชมกด room:ready ไม่ได้ → E_INVALID_STATE',
    isError(readyAsSpectator, 'E_INVALID_STATE'),
    readyAsSpectator,
  );

  // ---------------------------------------------------------------- เติมผู้เล่น
  console.log('\nผู้เล่นเข้าจนเต็ม · ที่นั่งเต็ม');
  const bobJoin = await emit<SnapshotAck>(bobSocket, 'room:join', { roomCode, as: 'player' });
  check(
    'ผู้เล่นที่เข้ามาเห็นหัวห้องเป็นผู้ชม',
    bobJoin.ok &&
      bobJoin.data.snapshot.host?.userId === alice.userId &&
      bobJoin.data.snapshot.players.every((player) => !player.isHost),
    bobJoin.ok ? bobJoin.data.snapshot : bobJoin,
  );
  await emit(eveSocket, 'room:join', { roomCode, as: 'player' });
  await emit(danSocket, 'room:join', { roomCode, as: 'spectator' });

  const danFull = await emit(danSocket, 'room:switch_seat', { to: 'player' });
  check(
    'ผู้เล่นเต็ม → ผู้ชมสลับเข้าไม่ได้ → E_ROOM_FULL',
    isError(danFull, 'E_ROOM_FULL'),
    danFull,
  );

  const bobStart = await emit(bobSocket, 'room:start', {});
  check('ผู้เล่นที่ไม่ใช่หัวห้องกดเริ่ม → E_NOT_HOST', isError(bobStart, 'E_NOT_HOST'), bobStart);

  // ---------------------------------------------------------------- รอบที่ 1: หัวห้องเป็นผู้ชม
  console.log('\nรอบที่ 1 — หัวห้องที่เป็นผู้ชมกดเริ่ม · ระหว่างแข่งสลับไม่ได้');
  const tab2Loading = waitFor(aliceTab2, 'match:loading', 10_000);
  const loading = waitFor(aliceSocket, 'match:loading', 10_000);
  const aliceStart = await emit(aliceSocket, 'room:start', {});
  check('หัวห้องที่เป็นผู้ชมกดเริ่มได้เมื่อผู้เล่นครบ', aliceStart.ok, aliceStart);
  check(
    'ทั้งสองแท็บของหัวห้องได้ match:loading',
    (await loading) !== null && (await tab2Loading) !== null,
  );

  const midBob = await emit(bobSocket, 'room:switch_seat', { to: 'spectator' });
  check(
    'ผู้เล่นสลับเป็นผู้ชมตอน LOADING → E_INVALID_STATE',
    isError(midBob, 'E_INVALID_STATE'),
    midBob,
  );
  const midJoin = await emit(bobSocket, 'room:join', { roomCode, as: 'spectator' });
  check(
    'room:join เป็นผู้ชมห้องเดิมระหว่างแข่ง (ทางอ้อม) → E_INVALID_STATE',
    isError(midJoin, 'E_INVALID_STATE'),
    midJoin,
  );

  const inspection = waitFor(aliceSocket, 'match:inspection_started', 10_000);
  for (const socket of [bobSocket, eveSocket]) await emit(socket, 'solve:ready', {});
  await inspection;
  const midAlice = await emit(aliceSocket, 'room:switch_seat', { to: 'player' });
  check(
    'ผู้ชมสลับเป็นผู้เล่นตอน INSPECTION → E_INVALID_STATE',
    isError(midAlice, 'E_INVALID_STATE'),
    midAlice,
  );
  const solving = waitFor(aliceSocket, 'match:started', 8_000);
  for (const socket of [bobSocket, eveSocket]) {
    await emit(socket, 'solve:inspection_ready', { ready: true });
  }
  await solving;

  const bobMoveSeen = waitFor<{ userId: number }>(aliceSocket, 'opponent:move', 2_000);
  bobSocket.emit('solve:move', { seq: 1, move: 'R', clientTs: Date.now() });
  const seenMove = await bobMoveSeen;
  check(
    'หัวห้องที่เป็นผู้ชมได้ opponent:move ของผู้เล่น',
    seenMove?.userId === bob.userId,
    seenMove,
  );

  await surrenderAll([bobSocket, eveSocket], aliceSocket);

  // ---------------------------------------------------------------- หลังจบรอบ: สลับกลับ
  console.log('\nหลังจบรอบ — สลับกลับมาเป็นผู้เล่น');
  const bobOut = await emit<SnapshotAck>(bobSocket, 'room:switch_seat', { to: 'spectator' });
  check(
    'FINISHED: ผู้เล่นสลับเป็นผู้ชมได้',
    bobOut.ok && bobOut.data.snapshot.players.length === 1,
    bobOut,
  );

  const joinedEvent = waitFor<{ player: { userId: number } }>(eveSocket, 'room:player_joined');
  const aliceBack = await emit<SnapshotAck>(aliceSocket, 'room:switch_seat', { to: 'player' });
  const back = aliceBack.ok ? aliceBack.data.snapshot : null;
  check(
    'FINISHED: หัวห้องสลับกลับมาเป็นผู้เล่นได้ · host seat: player · isHost บนที่นั่ง',
    back?.host?.userId === alice.userId &&
      back.host.seat === 'player' &&
      back.players.find((player) => player.userId === alice.userId)?.isHost === true,
    back,
  );
  const joined = await joinedEvent;
  check('คนอื่นได้ room:player_joined', joined?.player.userId === alice.userId, joined);

  // ---------------------------------------------------------------- รอบที่ 2: ผู้ชมกลับมาเป็นผู้เล่น
  console.log(
    '\nรอบที่ 2 — คนที่สลับมาเป็นผู้เล่นเล่นได้จริง · คนที่ไปเป็นผู้ชมส่งคำสั่งผู้เล่นไม่ได้',
  );
  await playUntilSolving(aliceSocket, [aliceSocket, eveSocket], eveSocket);

  const eveSeesAlice = waitFor<{ userId: number }>(eveSocket, 'opponent:move', 2_000);
  const bobSeesAlice = waitFor<{ userId: number }>(bobSocket, 'opponent:move', 2_000);
  const tab2SeesAlice = waitFor<{ userId: number }>(aliceTab2, 'opponent:move', 2_000);
  const aliceEcho = waitFor<{ userId: number }>(aliceSocket, 'opponent:move', 800);
  aliceSocket.emit('solve:move', { seq: 1, move: 'U', clientTs: Date.now() });
  check('move ของคนที่สลับมาถึงคู่แข่ง', (await eveSeesAlice)?.userId === alice.userId);
  check('… ถึงผู้ชม (คนที่เพิ่งสลับออกไป)', (await bobSeesAlice)?.userId === alice.userId);
  check('… ถึงแท็บที่สองของตัวเอง', (await tab2SeesAlice)?.userId === alice.userId);
  check('… ไม่สะท้อนกลับมาที่แท็บที่ส่ง', (await aliceEcho) === null);

  const bobSurrender = await emit(bobSocket, 'solve:surrender', {});
  check(
    'คนที่สลับไปเป็นผู้ชมยอมแพ้ไม่ได้ → E_INVALID_STATE',
    isError(bobSurrender, 'E_INVALID_STATE'),
    bobSurrender,
  );
  await surrenderAll([aliceSocket, eveSocket], eveSocket);

  // ---------------------------------------------------------------- room:join คนละที่นั่ง
  console.log('\nroom:join ห้องเดิมคนละที่นั่ง = สลับ (ไม่ซ้อนสองฝั่ง)');
  // ตอนนี้: ผู้เล่น alice, eve · ผู้ชม dan, bob
  await emit(eveSocket, 'room:switch_seat', { to: 'spectator' });
  const bobRejoin = await emit<SnapshotAck>(bobSocket, 'room:join', { roomCode, as: 'player' });
  const rejoinSnap = bobRejoin.ok ? bobRejoin.data.snapshot : null;
  check(
    'ผู้ชมกด room:join เป็นผู้เล่น → ได้ที่นั่งผู้เล่น และหายจากฝั่งผู้ชม',
    rejoinSnap?.players.some((player) => player.userId === bob.userId) === true &&
      rejoinSnap.spectatorCount === 2,
    rejoinSnap,
  );
  await emit(bobSocket, 'room:switch_seat', { to: 'spectator' });

  // ---------------------------------------------------------------- ลำดับการโอนหัวห้อง
  console.log('\nลำดับโอนหัวห้อง — ผู้เล่นคนแรก → ผู้ชมคนแรก → ยุบ');
  // ตอนนี้: ผู้เล่น alice · ผู้ชมตามลำดับ dan, eve, bob
  await emit(eveSocket, 'room:switch_seat', { to: 'player' });
  await emit(aliceSocket, 'room:switch_seat', { to: 'spectator' });
  // ผู้เล่น eve · ผู้ชม dan, bob, alice (หัวห้อง)

  const toEve = waitFor<{ newHostUserId: number }>(bobSocket, 'room:host_changed', 2_000);
  await emit(aliceSocket, 'room:leave', {});
  check(
    'หัวห้อง (ผู้ชม) ออก → ผู้เล่นคนแรกได้สิทธิ์ก่อนผู้ชม',
    (await toEve)?.newHostUserId === eve.userId,
  );

  await emit(eveSocket, 'room:switch_seat', { to: 'spectator' });
  const toDan = waitFor<{ newHostUserId: number }>(bobSocket, 'room:host_changed', 2_000);
  const noAbortEmpty = waitFor(bobSocket, 'room:aborted', 1_000);
  await emit(eveSocket, 'room:leave', {});
  check(
    'ไม่มีผู้เล่นเหลือ → ผู้ชมที่เข้ามาดูก่อนได้สิทธิ์',
    (await toDan)?.newHostUserId === dan.userId,
  );
  check('ห้องที่เหลือแต่ผู้ชมไม่ยุบ', (await noAbortEmpty) === null);

  const toBob = waitFor<{ newHostUserId: number }>(bobSocket, 'room:host_changed', 2_000);
  const bobState = waitFor<Snapshot>(bobSocket, 'room:state', 2_000);
  danSocket.disconnect();
  check(
    'หัวห้องที่เป็นผู้ชมปิดแท็บ → โอนทันที (ผู้ชมไม่มี grace)',
    (await toBob)?.newHostUserId === bob.userId,
  );
  check('… พร้อม room:state ที่ host ใหม่', (await bobState)?.host?.userId === bob.userId);

  await emit(bobSocket, 'room:leave', {});
  danSocket = await connect(dan.token);
  const gone = await emit(danSocket, 'room:join', { roomCode, as: 'spectator' });
  check('ไม่เหลือใครเลย → ห้องถูกยุบ', isError(gone, 'E_ROOM_NOT_FOUND'), gone);

  for (const socket of [aliceSocket, aliceTab2, bobSocket, eveSocket, danSocket]) {
    socket.disconnect();
  }
}

// ---------------------------------------------------------------- ห้องหลายคน

async function multiplayer(): Promise<void> {
  console.log('\nห้องหลายคน 3 คน — หัวห้องเป็นผู้ชม เริ่มและดูจนจบ');
  const auths = await Promise.all([
    login('somchai'),
    login('malee'),
    login('nattapong'),
    login('pimchanok'),
  ]);
  const [host, ...players] = (await Promise.all(auths.map((auth) => connect(auth.token)))) as [
    Socket,
    Socket,
    Socket,
    Socket,
  ];

  const created = await emit<{ roomCode: string }>(host, 'room:create', {
    cubeType: CUBE_TYPE,
    kind: 'multiplayer',
    maxPlayers: 3,
  });
  if (!created.ok) throw new Error(`สร้างห้องหลายคนไม่ผ่าน: ${created.error.code}`);
  const { roomCode } = created.data;

  const out = await emit<SnapshotAck>(host, 'room:switch_seat', { to: 'spectator' });
  check(
    'หัวห้องห้อง 3 คนสลับเป็นผู้ชมได้',
    out.ok && out.data.snapshot.host?.seat === 'spectator',
    out,
  );
  for (const socket of players) await emit(socket, 'room:join', { roomCode, as: 'player' });

  const finished = waitFor<{ results: { userId: number }[] }>(host, 'match:finished', 20_000);
  await playUntilSolving(host, players, host);
  await surrenderAll(players, host);
  const result = await finished;
  check(
    'จบรอบได้ · ผลมี 3 คนและไม่มีหัวห้องที่เป็นผู้ชม',
    result?.results.length === 3 && result.results.every((row) => row.userId !== auths[0]!.userId),
    result?.results,
  );

  const full = await emit(host, 'room:switch_seat', { to: 'player' });
  check('ผู้เล่นครบ 3 → หัวห้องสลับกลับไม่ได้ → E_ROOM_FULL', isError(full, 'E_ROOM_FULL'), full);

  await emit(players[0]!, 'room:switch_seat', { to: 'spectator' });
  const back = await emit<SnapshotAck>(host, 'room:switch_seat', { to: 'player' });
  check(
    'มีที่ว่างแล้วสลับกลับได้',
    back.ok &&
      back.data.snapshot.host?.seat === 'player' &&
      back.data.snapshot.players.length === 3,
    back,
  );

  for (const socket of [host, ...players]) await emit(socket, 'room:leave', {});
  for (const socket of [host, ...players]) socket.disconnect();
}

// ---------------------------------------------------------------- ห้องจากคิว

async function queueRoom(): Promise<void> {
  console.log('\nห้องจากคิว — สลับที่นั่งไม่ได้');
  const auths = await Promise.all([login('kanyarat'), login('supachai')]);
  const sockets = await Promise.all(auths.map((auth) => connect(auth.token)));
  for (const socket of sockets) autoAcceptMatches(socket);

  const matched = waitFor<{ roomId: number }>(sockets[0]!, 'queue:matched', 35_000);
  for (const socket of sockets) {
    await emit(socket, 'queue:join', { cubeType: 'pyramorphix', kind: 'competitive' });
  }
  const room = await matched;
  if (!room) {
    check('จับคู่ได้ภายใน 35 วินาที (Elo ของสองบัญชีต่างกันเกินไป?)', false);
    for (const socket of sockets) {
      await emit(socket, 'queue:leave', {});
      socket.disconnect();
    }
    return;
  }

  const denied = await emit<unknown>(sockets[0]!, 'room:switch_seat', { to: 'spectator' });
  check(
    'ห้องจากคิว → E_INVALID_STATE (ด่าน roomCode ไม่ใช่ด่าน state)',
    isError(denied, 'E_INVALID_STATE') && !denied.ok && denied.error.message.includes('จับคู่'),
    denied,
  );

  // ยอมแพ้ไม่ได้จนกว่าจะเริ่มจับเวลา — ตัดสายทิ้ง ห้องยุบเองเมื่อหมด grace (ไม่บันทึก DB)
  for (const socket of sockets) socket.disconnect();
}

async function main(): Promise<void> {
  console.log(`\n🔁 ทดสอบสลับผู้เล่น ↔ ผู้ชมที่ ${SERVER_URL} (${CUBE_TYPE})\n`);
  await duel();
  await multiplayer();
  await queueRoom();
  process.exit(summary());
}

main().catch((error: unknown) => {
  console.error('\n💥 สโมคเทสล้ม:', error);
  process.exit(1);
});
