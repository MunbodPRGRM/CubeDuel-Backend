/**
 * จำนวนสมาชิกออนไลน์ + รายชื่อคนออนไลน์ — `presence:count` · `GET /users/online` (เฟส 13 ก้อนที่ 24 · ADR-086)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว
 * รันด้วย: npm run smoke:presence     (~20 วินาที — รอรอบกระจาย 5 วินาทีจริงหลายรอบ)
 *
 * ครอบ: ได้ตัวเลขทันทีตอนต่อ · คนเข้า/ออกแล้วคนอื่นได้ตัวเลขใหม่ภายในรอบเดียว · หลายแท็บนับ 1 ·
 *       รายชื่อต้องล็อกอิน · กิจกรรม idle / in_room / spectating / queue · `q` · `limit` · ไม่มี roomCode หลุด
 *
 * ⚠️ เข้าสู่ระบบด้วยบัญชี seed = เตะเซสชันเดิมของบัญชีนั้นในเบราว์เซอร์ออก (ADR-076) เหมือนสโมคตัวอื่น
 */
import type { Socket } from 'socket.io-client';
import { API, check, connect, emit, login, SERVER_URL, summary, waitFor } from './smoke-helpers.js';

/** รอบกระจาย 5 วินาที + เผื่อ */
const BROADCAST_WAIT_MS = 7_000;

interface OnlineUser {
  userId: number;
  username: string;
  nickname: string | null;
  activity: string;
  cubeType: string | null;
}
interface OnlineUsers {
  online: number;
  total: number;
  users: OnlineUser[];
}

async function getOnline(
  token: string | null,
  query = '',
): Promise<{ status: number; body: { data?: OnlineUsers } }> {
  const res = await fetch(`${API}/users/online${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as { data?: OnlineUsers } };
}

function find(list: OnlineUsers | undefined, userId: number): OnlineUser | undefined {
  return list?.users.find((u) => u.userId === userId);
}

/** รอจนได้ `presence:count` ที่ตรงเงื่อนไข (รอบกระจายอาจส่งค่าระหว่างทางมาก่อน) */
function waitForCount(
  socket: Socket,
  predicate: (online: number) => boolean,
): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off('presence:count', listener);
      resolve(null);
    }, BROADCAST_WAIT_MS);
    const listener = ({ online }: { online: number }) => {
      if (!predicate(online)) return;
      clearTimeout(timer);
      socket.off('presence:count', listener);
      resolve(online);
    };
    socket.on('presence:count', listener);
  });
}

async function main(): Promise<void> {
  console.log(`\n🟢 ทดสอบสมาชิกออนไลน์ที่ ${SERVER_URL}\n`);

  // เข้าสู่ระบบให้ครบก่อนต่อ socket — login ซ้ำทีหลังจะตัด socket ของบัญชีนั้น (ADR-076)
  const [alice, bob, eve] = await Promise.all([
    login('somchai'),
    login('malee'),
    login('nattapong'),
  ]);

  // ---------------------------------------------------------------- ตัวเลข
  console.log('presence:count');
  const aliceSocket = await connect(alice.token);
  const first = await waitFor<{ online: number }>(aliceSocket, 'presence:count', 2_000);
  // ตัวเลขทันทีอาจมาถึงก่อน listener ติด → ถ้าพลาดให้ดึงจาก REST แทนเป็นค่าตั้งต้น
  const baseline = first?.online ?? (await getOnline(alice.token)).body.data?.online ?? 0;
  check('ต่อแล้วรู้จำนวนคนออนไลน์ (รวมตัวเอง ≥ 1)', baseline >= 1, baseline);

  const bobSocket = await connect(bob.token);
  const afterBob = await waitForCount(aliceSocket, (n) => n === baseline + 1);
  check(
    `bob ต่อเข้ามา → alice ได้ ${baseline + 1} ภายในรอบเดียว`,
    afterBob === baseline + 1,
    afterBob,
  );

  const aliceSecondTab = await connect(alice.token);
  const noChange = await waitFor<{ online: number }>(
    bobSocket,
    'presence:count',
    BROADCAST_WAIT_MS,
  );
  check('alice เปิดแท็บที่สอง → ไม่มีการกระจาย (ยังนับ 1 คน)', noChange === null, noChange);
  aliceSecondTab.disconnect();

  // ---------------------------------------------------------------- รายชื่อ
  console.log('\nGET /users/online');
  const anonymous = await getOnline(null);
  check('ไม่มี token → 401', anonymous.status === 401, anonymous.status);

  const list = await getOnline(alice.token);
  check('มี token → 200', list.status === 200, list.status);
  check(
    'ตัวเลข online ตรงกับ presence:count',
    list.body.data?.online === baseline + 1,
    list.body.data?.online,
  );
  check(
    'รายชื่อมีทั้ง alice และ bob',
    !!find(list.body.data, alice.userId) && !!find(list.body.data, bob.userId),
  );
  check(
    'alice ว่างอยู่ → idle · cubeType null',
    find(list.body.data, alice.userId)?.activity === 'idle' &&
      find(list.body.data, alice.userId)?.cubeType === null,
  );
  check(
    'alice ขึ้นครั้งเดียวแม้เคยเปิดสองแท็บ',
    list.body.data?.users.filter((u) => u.userId === alice.userId).length === 1,
  );
  const leaked = list.body.data?.users.some(
    (u) => 'roomCode' in u || 'email' in u || 'cubeSkin' in u,
  );
  check('ไม่มี roomCode / email / cubeSkin หลุดมา', leaked === false);

  const search = await getOnline(alice.token, '?q=MALE');
  check(
    'q=MALE (ตัวพิมพ์ใหญ่) → เจอ malee คนเดียวในสองคนนี้',
    !!find(search.body.data, bob.userId) && !find(search.body.data, alice.userId),
    search.body.data?.users.map((u) => u.username),
  );

  const limited = await getOnline(alice.token, '?limit=1');
  check(
    'limit=1 → ได้ 1 แถว แต่ total ยังนับทุกคน',
    limited.body.data?.users.length === 1 && (limited.body.data?.total ?? 0) >= 2,
    limited.body.data,
  );
  const badLimit = await getOnline(alice.token, '?limit=51');
  check('limit=51 → 400', badLimit.status === 400, badLimit.status);

  // ---------------------------------------------------------------- กิจกรรม
  console.log('\nกิจกรรม');
  const eveSocket = await connect(eve.token);
  const created = await emit<{ roomCode: string }>(aliceSocket, 'room:create', {
    cubeType: '2x2x2',
    kind: 'custom',
    maxPlayers: 2,
  });
  if (!created.ok) throw new Error(`สร้างห้องไม่ผ่าน: ${created.error.code}`);
  const watching = await emit(bobSocket, 'room:join', {
    roomCode: created.data.roomCode,
    as: 'spectator',
  });
  if (!watching.ok) throw new Error(`เข้าเป็นผู้ชมไม่ผ่าน: ${watching.error.code}`);
  // คิวหลายคนต้องครบ 3 คน — eve อยู่คนเดียวจึงค้างอยู่ในคิวได้แน่นอน
  const queued = await emit(eveSocket, 'queue:join', {
    cubeType: 'pyramorphix',
    kind: 'multiplayer',
  });
  if (!queued.ok) throw new Error(`เข้าคิวไม่ผ่าน: ${queued.error.code}`);

  const busy = (await getOnline(alice.token)).body.data;
  const a = find(busy, alice.userId);
  const b = find(busy, bob.userId);
  const e = find(busy, eve.userId);
  check(
    'หัวห้องที่ยังไม่เริ่ม → in_room 2x2x2',
    a?.activity === 'in_room' && a.cubeType === '2x2x2',
    a,
  );
  check('ผู้ชม → spectating 2x2x2', b?.activity === 'spectating' && b.cubeType === '2x2x2', b);
  check('รอคิว → queue pyramorphix', e?.activity === 'queue' && e.cubeType === 'pyramorphix', e);
  const order = busy?.users.map((u) => u.activity) ?? [];
  check(
    'เรียง spectating → in_room → queue',
    order.indexOf('spectating') < order.indexOf('in_room') &&
      order.indexOf('in_room') < order.indexOf('queue'),
    order,
  );

  await emit(eveSocket, 'queue:leave', {});
  await emit(bobSocket, 'room:leave', {});
  await emit(aliceSocket, 'room:leave', {});
  const calm = (await getOnline(alice.token)).body.data;
  check(
    'ออกจากคิว/ห้องแล้ว → idle ทั้งหมด',
    [alice, bob, eve].every((u) => find(calm, u.userId)?.activity === 'idle'),
  );

  // ---------------------------------------------------------------- หลุด
  console.log('\nหลุด');
  // รอบของ eve ที่ต่อเข้ามายังค้างอยู่ — รอให้ผ่านไปก่อน จะได้วัดจากค่าที่นิ่งแล้ว
  await waitForCount(aliceSocket, (n) => n === baseline + 2);
  bobSocket.disconnect();
  eveSocket.disconnect();
  const afterLeave = await waitForCount(aliceSocket, (n) => n === baseline);
  check(
    `bob กับ eve หลุด → กระจายครั้งเดียวเหลือ ${baseline}`,
    afterLeave === baseline,
    afterLeave,
  );
  const gone = (await getOnline(alice.token)).body.data;
  check('รายชื่อไม่มี bob แล้ว', !find(gone, bob.userId));

  aliceSocket.disconnect();
  process.exit(summary());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
