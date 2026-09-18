/**
 * คิวจับคู่อัตโนมัติ — อยู่ใน memory ของ process เดียว เหมือนทะเบียนห้อง
 *
 * รองรับสองแบบที่ **แยกช่องกันสนิท** (`kind` + `cubeType` เป็นตัวแบ่งช่อง):
 *   - `competitive` = 1v1 · ช่วง Elo ขยายตามเวลารอ · ห้ามเจอคนเดิมซ้ำติดกัน
 *   - `multiplayer` = 3–4 คน · ไม่ใช้ช่วง Elo · ครบ 4 เริ่มทันที รอเกิน 60 วิแล้วมี 3 คนก็เริ่ม
 *
 * กติกา: `docs/game-rules.md` ข้อ 8 (หมดเวลารอ 180 วิเหมือนกันทั้งสองแบบ)
 * สัญญา event: `docs/socket-events.md` ข้อ 4 · การตัดสินใจที่เอกสารไม่ได้ระบุอยู่ใน ADR-039 + ADR-043
 *
 * หลักการของไฟล์นี้:
 *   - **ตรรกะเลือกคู่/จับกลุ่มไม่อยู่ที่นี่** อยู่ที่ `lib/matchmaking.ts` ซึ่งเป็น pure function มีเทสคุม
 *   - รายการในคิวผูกกับ **socket ที่กดเข้าคิว** — socket นั้นหลุด = ออกจากคิวทันที (ADR-039 ข้อ 1)
 *   - ตัวจับเวลาเปิดตอนมีคนเข้าคิวคนแรก ปิดตอนคิวว่าง (ADR-039 ข้อ 7)
 *   - **จับกลุ่มได้แล้วยังไม่สร้างห้อง** — เข้า `READY_CHECK` ให้ทุกคนกดยืนยันภายใน 12 วินาทีก่อน
 *     (ADR-077) คนที่รอยืนยัน **ยังอยู่ใน `queue`** แต่ถูกกันไม่ให้จับซ้ำด้วย `pending`
 */
import {
  MULTIPLAYER_ROOM_MIN,
  QUEUE_STATUS_INTERVAL_MS,
  QUEUE_TICK_MS,
  QUEUE_TIMEOUT_MS,
  READY_CHECK_MS,
} from '../constants.js';
import { eloWindowFor, groupUp, pairUp, type QueueCandidate } from '../lib/matchmaking.js';
import type { TypedServer, TypedSocket } from './ack.js';
import { socketErrors } from './errors.js';
import { beginLoading } from './match.js';
import { createRoom } from './room-registry.js';
import {
  abortRoom,
  broadcastState,
  eloOf,
  joinAsPlayer,
  leavePreviousRoom,
  removePlayerFromRoom,
} from './room-service.js';
import type { Room } from './room.js';
import type {
  CubeType,
  QueueAcceptResult,
  QueueJoinPayload,
  QueueJoinResult,
  QueueKind,
  QueueRival,
  RoomKind,
  RoomMode,
} from './types.js';

/** คู่ล่าสุดจำไว้นานเท่านี้ แล้วถือว่าเจอกันใหม่ได้ (ADR-039 ข้อ 4) */
const LAST_OPPONENT_TTL_MS = 30 * 60_000;

interface QueueEntry extends QueueCandidate {
  /** socket ที่กดเข้าคิว — ตัวเดียวเท่านั้นที่ถือคิวนี้ไว้ */
  socketId: string;
  cubeType: CubeType;
  kind: QueueKind;
  /** ชื่อไว้โชว์ในหน้ายืนยัน — เอาจาก `socket.data` ไม่ต้องยิง DB ซ้ำ (ADR-077) */
  username: string;
  nickname: string | null;
  /** ส่ง `queue:status` ไปแล้วกี่ครั้ง — ใช้เทียบว่าถึงรอบถัดไปหรือยัง */
  statusSent: number;
}

/**
 * กลุ่มที่จับได้แล้วแต่ยังรอให้ทุกคนกดยืนยัน — **ยังไม่มีห้อง ไม่มีอะไรลง DB** (ADR-077)
 * คนในกลุ่มยังอยู่ใน `queue` ตามเดิม แค่ถูกข้ามตอนกวาดคิว
 */
interface PendingMatch {
  kind: QueueKind;
  cubeType: CubeType;
  /** ทุกคนในกลุ่ม เรียงตามที่ `matchmaking` จับมา */
  members: QueueEntry[];
  /** userId ที่กดยอมรับแล้ว */
  accepted: Set<number>;
  expiresAtTs: number;
}

/** userId → รายการในคิว (หนึ่งคนอยู่ได้ช่องเดียว — ADR-039 ข้อ 1) */
const queue = new Map<number, QueueEntry>();

/** userId → กลุ่มที่กำลังรอยืนยันอยู่ (คนละ Map กับ `queue` แต่ชี้ไป object เดียวกัน) */
const pending = new Map<number, PendingMatch>();

/** userId → คู่แข่งคนล่าสุด ไว้เลี่ยงการเจอซ้ำติดกัน (หายตอนรีสตาร์ท ตั้งใจให้เป็นแบบนั้น) */
const lastOpponents = new Map<number, { opponentId: number; atTs: number }>();

let ticker: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------- ตัวช่วย

/** ช่องคิวหนึ่งช่อง = ประเภทห้อง + ประเภทรูบิค (คนละช่องไม่มีวันเจอกัน) */
function slotKey(entry: Pick<QueueEntry, 'kind' | 'cubeType'>): string {
  return `${entry.kind}|${entry.cubeType}`;
}

function countInSlot(slot: string): number {
  let count = 0;
  for (const entry of queue.values()) if (slotKey(entry) === slot) count++;
  return count;
}

function lastOpponentOf(userId: number, now: number): number | null {
  const record = lastOpponents.get(userId);
  if (!record) return null;
  if (now - record.atTs > LAST_OPPONENT_TTL_MS) {
    lastOpponents.delete(userId);
    return null;
  }
  return record.opponentId;
}

function rememberOpponents(a: number, b: number, now: number): void {
  lastOpponents.set(a, { opponentId: b, atTs: now });
  lastOpponents.set(b, { opponentId: a, atTs: now });
}

/** ส่ง event ให้ socket ที่ถือคิวอยู่ตัวเดียว (ไม่ใช่ทุกแท็บของคนนั้น — ADR-039 ข้อ 1) */
function socketOf(io: TypedServer, entry: QueueEntry): TypedSocket | null {
  return (io.sockets.sockets.get(entry.socketId) as TypedSocket | undefined) ?? null;
}

function sendStatus(io: TypedServer, entry: QueueEntry, now: number): void {
  const waitedMs = now - entry.queuedAtTs;
  socketOf(io, entry)?.emit('queue:status', {
    // server พาคนกลับเข้าคิวเองได้ client จึงจำเองไม่ได้ว่ากำลังรออะไรอยู่ (ADR-044 ข้อ 2)
    kind: entry.kind,
    cubeType: entry.cubeType,
    waitedMs,
    // คิวห้องหลายคนไม่ใช้ช่วง Elo เลย จึงเป็น null เสมอ (game-rules.md ข้อ 8)
    eloWindow: entry.kind === 'multiplayer' ? null : eloWindowFor(waitedMs),
    playersInQueue: countInSlot(slotKey(entry)),
  });
}

/** ห้องที่ช่องคิวนี้จะสร้างขึ้นมา — คิว 1v1 ได้ห้องแข่งขัน · คิวหลายคนได้ห้องโหมด auto */
function roomShapeOf(kind: QueueKind): { roomKind: RoomKind; roomMode: RoomMode | null } {
  return kind === 'multiplayer'
    ? { roomKind: 'multiplayer', roomMode: 'auto' }
    : { roomKind: 'competitive', roomMode: null };
}

// ---------------------------------------------------------------- เข้า/ออกคิว

/**
 * `queue:join` — เข้าคิวหาคู่
 * อยู่ในห้องที่ยังไม่เริ่มแข่งอยู่ก็เข้าคิวได้ server พาออกจากห้องให้เอง
 * (ห้องที่กำลังแข่งอยู่ `leavePreviousRoom` จะโยน `E_INVALID_STATE` ให้)
 */
export async function joinQueue(
  io: TypedServer,
  socket: TypedSocket,
  payload: QueueJoinPayload,
): Promise<QueueJoinResult> {
  const { userId } = socket.data;
  if (queue.has(userId)) throw socketErrors.alreadyInQueue();

  leavePreviousRoom(io, socket);
  const eloRating = await eloOf(userId, payload.cubeType);
  // ระหว่าง await อาจมีอีกแท็บกดเข้าคิวไปแล้ว
  if (queue.has(userId)) throw socketErrors.alreadyInQueue();

  const now = Date.now();
  const entry: QueueEntry = {
    userId,
    socketId: socket.id,
    cubeType: payload.cubeType,
    kind: payload.kind,
    username: socket.data.username,
    nickname: socket.data.nickname,
    eloRating,
    queuedAtTs: now,
    lastOpponentId: lastOpponentOf(userId, now),
    statusSent: 0,
  };
  queue.set(userId, entry);
  startTicker(io);

  return { queuedAtTs: now, playersInQueue: countInSlot(slotKey(entry)) };
}

/**
 * `queue:leave` — คืน `false` ถ้าไม่ได้อยู่ในคิวอยู่แล้ว (ไม่ถือว่าผิดพลาด)
 * กดตอนกำลังรอยืนยันอยู่ **มีผลเท่ากับปฏิเสธ** (ADR-077 ข้อ 5) จึงต้องยกเลิกทั้งกลุ่มให้ด้วย
 */
export function leaveQueue(io: TypedServer, userId: number): boolean {
  // เช็กก่อนยกเลิกกลุ่ม เพราะ `declinePendingOf` ถอดคนที่ปฏิเสธออกจากคิวไปแล้ว
  const wasQueued = queue.has(userId);
  declinePendingOf(io, userId);
  queue.delete(userId);
  stopTickerIfIdle();
  return wasQueued;
}

/** socket หลุด → ออกจากคิวทันที (game-rules.md ข้อ 6) — แท็บอื่นไม่ได้ถือคิวแทน */
export function removeSocketFromQueue(io: TypedServer, socketId: string): void {
  for (const [userId, entry] of queue) {
    if (entry.socketId !== socketId) continue;
    // หลุดระหว่างรอยืนยัน = ปฏิเสธ — คนที่เหลือต้องไม่ค้างหน้ายืนยันจนหมดเวลา (ADR-077 ข้อ 5)
    declinePendingOf(io, userId);
    queue.delete(userId);
  }
  stopTickerIfIdle();
}

/** ประเภทรูบิคที่ผู้ใช้คนนี้กำลังรอจับคู่ (รวมช่วงรอกดยืนยัน) · ไม่อยู่ในคิว = `null` — ADR-086 ข้อ 3 */
export function queuedCubeTypeOf(userId: number): CubeType | null {
  return queue.get(userId)?.cubeType ?? null;
}

/** ไว้ดูตอน debug / เขียนเทส */
export function queueSize(): number {
  return queue.size;
}

/** ใช้ในเทสเท่านั้น — ล้างคิวและตัวจับเวลาทั้งหมด */
export function resetQueue(): void {
  queue.clear();
  pending.clear();
  lastOpponents.clear();
  if (ticker) clearInterval(ticker);
  ticker = null;
}

// ---------------------------------------------------------------- ตัวกวาดคิว

function startTicker(io: TypedServer): void {
  if (ticker) return;
  ticker = setInterval(() => tick(io), QUEUE_TICK_MS);
  // ไม่ให้ตัวจับเวลาค้าง event loop ตอนสั่งปิด process
  ticker.unref();
}

function stopTickerIfIdle(): void {
  if (!ticker || queue.size > 0) return;
  clearInterval(ticker);
  ticker = null;
}

/**
 * จับกลุ่มได้ → เข้า `READY_CHECK` **ยังไม่สร้างห้อง** (ADR-077 ข้อ 1)
 *
 * ทุกคนยังอยู่ใน `queue` ต่อ แค่มีรายการใน `pending` กันไม่ให้ถูกจับซ้ำ —
 * ยกเลิกกลุ่มแล้วคนที่ยอมรับจึงรอคิวต่อได้ทันทีโดยไม่ต้องใส่กลับ (ADR-077 ข้อ 4)
 * คืนโดยไม่ทำอะไรถ้ามีใครหลุดออกจากคิวไประหว่างนี้ (คนที่เหลือรอ tick ถัดไปเอง)
 */
function startReadyCheck(io: TypedServer, userIds: readonly number[], now: number): void {
  const entries = userIds.map((userId) => queue.get(userId));
  if (entries.some((entry) => entry === undefined)) return;

  const members = entries as QueueEntry[];
  // ไม่ควรเกิด (ตัวกวาดกรองคนที่รอยืนยันออกไปแล้ว) แต่กันไว้ไม่ให้กลุ่มซ้อนกลุ่ม
  if (members.some((entry) => pending.has(entry.userId))) return;
  // สายขาดไปแล้วก็ไม่ต้องตั้งกลุ่ม — tick ถัดไปจะถอดคนนั้นออกเอง
  if (members.some((entry) => socketOf(io, entry) === null)) return;

  const group: PendingMatch = {
    kind: members[0]!.kind,
    cubeType: members[0]!.cubeType,
    members,
    accepted: new Set(),
    expiresAtTs: now + READY_CHECK_MS,
  };
  for (const entry of members) pending.set(entry.userId, group);
  broadcastMatchFound(io, group);
}

/** คนอื่นในกลุ่ม (ไม่รวมตัวเอง) ในรูปที่ส่งให้ client ได้ */
function rivalsFor(group: PendingMatch, selfUserId: number): QueueRival[] {
  return group.members
    .filter((entry) => entry.userId !== selfUserId)
    .map((entry) => ({
      userId: entry.userId,
      username: entry.username,
      nickname: entry.nickname,
      eloRating: entry.eloRating,
    }));
}

/**
 * ส่ง `queue:match_found` ให้ทุกคนในกลุ่ม — payload เป็น **สถานะทั้งใบ ไม่ใช่ delta**
 * จึงส่งซ้ำได้ทุกครั้งที่มีคนกดยอมรับ client เอาใบล่าสุดทับของเดิม (ADR-077 ข้อ 6)
 */
function broadcastMatchFound(io: TypedServer, group: PendingMatch): void {
  for (const entry of group.members) {
    socketOf(io, entry)?.emit('queue:match_found', {
      kind: group.kind,
      cubeType: group.cubeType,
      rivals: rivalsFor(group, entry.userId),
      groupSize: group.members.length,
      acceptedCount: group.accepted.size,
      youAccepted: group.accepted.has(entry.userId),
      expiresAtTs: group.expiresAtTs,
    });
  }
}

/**
 * ยกเลิกกลุ่มทั้งกลุ่ม — ไม่มีอะไรลง DB ไม่แตะ Elo (ADR-077 ข้อ 8)
 *
 * `leavingUserIds` คือคนที่ต้องออกจากคิวไปด้วย · **ที่เหลืออยู่ในคิวต่อโดยไม่รีเซ็ตเวลารอ**
 * (ADR-077 ข้อ 5) แล้วได้ `queue:status` ทันทีหนึ่งใบเพื่อให้จอปิดหน้ายืนยันกลับไปหน้ารอคิว
 *
 * 🔴 **คนที่ออกจากคิวที่นี่ไม่ได้รับ event อะไรเลย** — ผู้เรียกต้องรับผิดชอบบอกเขาเอง
 * (กด `queue:decline`/`queue:leave` มีค่า ack ตอบอยู่แล้ว · หมดเวลาต้องยิง `queue:timeout` ให้)
 * ถ้าลืม หน้ายืนยันของเขาจะค้างบนจอตลอดไปเพราะไม่มีอะไรไปสั่งให้ปิด (ADR-077 ข้อ 6)
 *
 * ไม่เรียก `rememberOpponents()` — คู่ที่ปฏิเสธกันยังจับมาเจอกันใหม่ได้ (ADR-077 ข้อ 2)
 */
function cancelGroup(
  io: TypedServer,
  group: PendingMatch,
  leavingUserIds: ReadonlySet<number>,
): void {
  for (const entry of group.members) pending.delete(entry.userId);

  const now = Date.now();
  for (const entry of group.members) {
    if (leavingUserIds.has(entry.userId)) queue.delete(entry.userId);
    else sendStatus(io, entry, now);
  }
}

/**
 * หมดเวลายืนยัน 12 วินาที — คนที่ไม่กดยอมรับถือว่าปฏิเสธ (game-rules.md ข้อ 8)
 *
 * ต่างจากการกดยกเลิกเองตรงที่ **ไม่มี ack ให้ยึด** จึงต้องยิง `queue:timeout` ตามไปด้วย
 * ไม่งั้นหน้ายืนยันของคนที่ปล่อยหมดเวลาจะค้างอยู่บนจอ (ADR-077 ข้อ 6)
 */
function expireGroup(io: TypedServer, group: PendingMatch, now: number): void {
  const timedOut = group.members.filter((entry) => !group.accepted.has(entry.userId));
  cancelGroup(io, group, new Set(timedOut.map((entry) => entry.userId)));

  for (const entry of timedOut) {
    socketOf(io, entry)?.emit('queue:timeout', {
      // เวลาที่รออยู่ในคิวทั้งหมด ไม่ใช่ 12 วินาทีของช่วงยืนยัน
      waitedMs: now - entry.queuedAtTs,
      reason: 'ready_check',
    });
  }
}

/**
 * คนนี้กำลังรอยืนยันอยู่หรือเปล่า — ถ้าใช่ถือว่า **เขาปฏิเสธ** แล้วยกเลิกทั้งกลุ่ม
 * ใช้ร่วมกันทั้งตอนกด `queue:decline` · กด `queue:leave` · และตอน socket หลุด
 *
 * 🔴 **ออกจากคิวแค่คนที่ปฏิเสธคนเดียว** — กติกา "หมดเวลา = ปฏิเสธ" ใช้กับ **การหมดเวลาจริง**
 * เท่านั้น (ดู `tick()`) คนที่ยังไม่ทันได้กดเพราะอีกฝ่ายกดยกเลิกตั้งแต่วินาทีที่ 2
 * ยังไม่ได้ปฏิเสธอะไร — ถ้าถอดออกด้วยจะเป็นการลงโทษคนที่ไม่ได้ทำอะไรผิด (ADR-077 ข้อ 5)
 */
function declinePendingOf(io: TypedServer, userId: number): void {
  const group = pending.get(userId);
  if (!group) return;
  // คนนี้รู้ตัวอยู่แล้วจาก ack ของ `queue:decline` / `queue:leave` (หรือสายขาดไปแล้ว)
  cancelGroup(io, group, new Set([userId]));
}

/**
 * กวาดคิวหนึ่งรอบ: หมดเวลายืนยันก่อน → จับคู่/จับกลุ่ม → แจ้งสถานะ/หมดเวลาให้คนที่ยังรออยู่
 *
 * คนที่กำลังรอยืนยัน (`pending`) ถูกข้ามทั้งสามขั้น — ทั้งจับซ้ำ ทั้ง `queue:status`
 * และทั้งกติกาหมดเวลารอ 180 วินาที (ADR-077 ข้อ 4)
 */
function tick(io: TypedServer): void {
  const now = Date.now();

  // หมดเวลานับถอยหลัง = ปฏิเสธ — ที่นี่ที่เดียวที่คนไม่กดอะไรเลยถูกถอดออกจากคิว
  // (game-rules.md ข้อ 8) · คนที่กดยอมรับไว้แล้วรอคิวต่อโดยไม่ต้องกดใหม่
  for (const [userId, group] of [...pending]) {
    // กลุ่มเดียวมีหลายสมาชิก — ถูกยกเลิกไปแล้วในรอบนี้ก็ข้าม
    if (!pending.has(userId)) continue;
    if (now >= group.expiresAtTs) expireGroup(io, group, now);
  }

  const slots = new Map<string, QueueEntry[]>();
  for (const entry of queue.values()) {
    if (pending.has(entry.userId)) continue;
    const key = slotKey(entry);
    const bucket = slots.get(key);
    if (bucket) bucket.push(entry);
    else slots.set(key, [entry]);
  }

  for (const entries of slots.values()) {
    // ทุกคนในช่องเดียวกันมี kind เท่ากันเสมอ (slotKey ประกอบด้วย kind)
    if (entries[0]?.kind === 'multiplayer') {
      for (const group of groupUp(entries, now)) {
        startReadyCheck(
          io,
          group.map((waiter) => waiter.userId),
          now,
        );
      }
    } else {
      for (const pair of pairUp(entries, now)) {
        startReadyCheck(io, [pair.a.userId, pair.b.userId], now);
      }
    }
  }

  for (const entry of [...queue.values()]) {
    // กำลังตัดสินใจอยู่ ห้ามเตะออกกลางคัน และไม่ต้องยิงสถานะซ้อนหน้ายืนยัน
    if (pending.has(entry.userId)) continue;
    const waitedMs = now - entry.queuedAtTs;

    if (waitedMs >= QUEUE_TIMEOUT_MS) {
      queue.delete(entry.userId);
      socketOf(io, entry)?.emit('queue:timeout', { waitedMs, reason: 'no_match' });
      continue;
    }
    if (waitedMs >= (entry.statusSent + 1) * QUEUE_STATUS_INTERVAL_MS) {
      entry.statusSent++;
      sendStatus(io, entry, now);
    }
  }

  stopTickerIfIdle();
}

// ---------------------------------------------------------------- ยืนยัน/ปฏิเสธ

/**
 * `queue:accept` — ยืนยันว่าจะเล่นกลุ่มที่เจอ · กดซ้ำไม่ใช่ error (ADR-077 ข้อ 6)
 * ครบทุกคนเมื่อไหร่ **ถึงจะสร้างห้อง** ด้วยเส้นทางเดิม
 */
export function acceptMatch(io: TypedServer, socket: TypedSocket): QueueAcceptResult {
  const { userId } = socket.data;
  const group = pending.get(userId);
  if (!group) throw socketErrors.invalidState('ตอนนี้ไม่มีคู่ที่รอการยืนยันอยู่');

  group.accepted.add(userId);
  const result = { accepted: group.accepted.size, groupSize: group.members.length };

  if (group.accepted.size < group.members.length) {
    // ยังไม่ครบ — บอกทุกคนว่าตอนนี้กี่คนแล้ว (ห้องหลายคนใช้โชว์ "2/4")
    broadcastMatchFound(io, group);
    return result;
  }

  for (const entry of group.members) {
    pending.delete(entry.userId);
    queue.delete(entry.userId);
  }
  stopTickerIfIdle();
  void openMatchedRoom(io, group.members);
  return result;
}

/** `queue:decline` — ปฏิเสธกลุ่มที่เจอ → ออกจากคิว (มีผลเท่ากับ `queue:leave`) */
export function declineMatch(io: TypedServer, socket: TypedSocket): { left: boolean } {
  const { userId } = socket.data;
  if (!pending.has(userId)) throw socketErrors.invalidState('ตอนนี้ไม่มีคู่ที่รอการยืนยันอยู่');
  return { left: leaveQueue(io, userId) };
}

// ---------------------------------------------------------------- เจอคู่แล้ว

/**
 * สร้างห้องของกลุ่มที่จับได้ แล้วดันทุกคนเข้าห้อง (2 คนสำหรับคิว 1v1 · 3–4 คนสำหรับคิวหลายคน)
 * ห้องนี้ **ไม่มีรหัสห้อง ไม่มีผู้ชม และกดเริ่มเองไม่ได้** — server เริ่มให้เอง (ADR-039 ข้อ 5)
 */
async function openMatchedRoom(io: TypedServer, group: readonly QueueEntry[]): Promise<void> {
  const first = group[0];
  if (!first) return;

  /**
   * บางคนอาจเพิ่งหลุดไปพอดีระหว่างที่ tick กำลังจับกลุ่ม — ถ้าคนที่ยังต่ออยู่ไม่พอเปิดห้อง
   * ก็ส่งกลับเข้าคิวโดยไม่เสียอะไร (คิวหลายคนต้องการอย่างน้อย 3 · คิว 1v1 ต้องการ 2)
   */
  const required = first.kind === 'multiplayer' ? MULTIPLAYER_ROOM_MIN : 2;
  const live = group
    .map((entry) => ({ entry, socket: socketOf(io, entry) }))
    .filter((seat): seat is { entry: QueueEntry; socket: TypedSocket } => seat.socket !== null);

  if (live.length < required) {
    for (const seat of live) requeue(io, seat.entry);
    return;
  }

  const shape = roomShapeOf(first.kind);
  const room = createRoom({
    ...shape,
    cubeType: first.cubeType,
    // ขนาดห้องคือจำนวนคนที่คิวจับมาได้จริง (กลุ่มเล็กที่รอครบ 60 วิได้ห้อง 3 คน)
    maxPlayers: live.length,
    withCode: false,
  });
  // ยุบก่อนเริ่มจับเวลาเมื่อไร คนที่ยังต่ออยู่กลับเข้าคิวเอง (game-rules.md ข้อ 6 · ADR-039 ข้อ 6)
  room.onAbort = (aborted) => requeueFromRoom(io, aborted);

  try {
    for (const seat of live) await joinAsPlayer(io, seat.socket, room);
  } catch (error) {
    console.error('[queue] พาผู้เล่นเข้าห้องที่จับคู่ได้ไม่สำเร็จ', error);
    abortRoom(io, room, 'player_left', 'เข้าห้องที่จับคู่ได้ไม่สำเร็จ กลับเข้าคิวให้อัตโนมัติ');
    return;
  }

  const now = Date.now();
  // "ห้ามเจอคนเดิมซ้ำติดกัน" เป็นกติกาของคิว 1v1 เท่านั้น (game-rules.md ข้อ 8)
  const [a, b] = live;
  if (live.length === 2 && a && b) rememberOpponents(a.entry.userId, b.entry.userId, now);

  room.state = 'MATCHED';
  room.touch();

  const players = [...room.players.values()].map((player) => room.toPublicPlayer(player));
  for (const seat of live) {
    seat.socket.emit('queue:matched', {
      roomId: room.roomId,
      cubeType: room.cubeType,
      players,
    });
  }
  broadcastState(io, room);

  // เห็นคู่แข่งไปแล้วตั้งแต่ `READY_CHECK` จึงไม่ต้องหน่วงอีก — เข้า LOADING ทันที (ADR-077 ข้อ 7)
  await startMatchedRoom(io, room);
}

/**
 * คนที่หลุดไประหว่างกำลังพาเข้าห้อง — `beginLoading()` ไม่ยอมเริ่มถ้ายังมีที่นั่งที่ไม่มี socket
 * และ grace 30 วินาทีก็ยาวเกินกว่าจะรอ · ห้องหลายคนจึงถอดคนที่หลุดออกแล้วเริ่มด้วยคนที่เหลือ
 * ถ้ายังถึงขั้นต่ำ (ADR-041 ข้อ 3) — ห้อง 1v1 ไม่มีทางเหลือพอ จึงตกไปเป็นการยุบห้องเหมือนเดิม
 */
function dropDisconnectedBeforeStart(io: TypedServer, room: Room): void {
  if (room.roomKind !== 'multiplayer') return;
  const offline = [...room.players.values()].filter((player) => player.sockets.size === 0);
  if (offline.length === 0) return;
  if (room.players.size - offline.length < room.minPlayersToStart) return;
  for (const player of offline) removePlayerFromRoom(io, room, player.userId, 'disconnected');
}

/** ห้องพร้อมแล้ว — เริ่มแมตช์ให้เอง ไม่มีใครต้องกดปุ่ม (`room:start` ใช้กับห้องจากคิวไม่ได้) */
async function startMatchedRoom(io: TypedServer, room: Room): Promise<void> {
  if (room.state !== 'MATCHED') return;
  room.clearPhaseTimer();
  dropDisconnectedBeforeStart(io, room);

  try {
    await beginLoading(io, room);
  } catch (error) {
    // ผู้เล่นหลุดไปพอดีระหว่างกำลังเริ่ม — ยุบห้องแล้วส่งคนที่เหลือกลับเข้าคิว
    console.error(`[queue] ห้อง ${room.roomId} เริ่มไม่สำเร็จ`, error);
    abortRoom(io, room, 'player_left', 'ผู้เล่นหลุดการเชื่อมต่อก่อนเริ่ม กลับเข้าคิวให้อัตโนมัติ');
  }
}

// ---------------------------------------------------------------- กลับเข้าคิว

/** ใส่คนที่ถูกส่งกลับเข้าคิวลงคิวใหม่ (เวลารอเริ่มนับใหม่) */
function requeue(io: TypedServer, entry: QueueEntry, lastOpponentId?: number | null): void {
  const socket = socketOf(io, entry);
  if (!socket || queue.has(entry.userId)) return;

  const now = Date.now();
  const fresh: QueueEntry = {
    ...entry,
    queuedAtTs: now,
    statusSent: 0,
    lastOpponentId:
      lastOpponentId === undefined ? lastOpponentOf(entry.userId, now) : lastOpponentId,
  };
  queue.set(fresh.userId, fresh);
  startTicker(io);
  // บอกสถานะทันทีเพื่อให้จอกลับไปเป็นหน้ารอคิวโดยไม่ต้องรออีก 5 วินาที
  sendStatus(io, fresh, now);
}

/**
 * ห้องที่มาจากคิวถูกยุบก่อนเริ่มจับเวลา → คนที่ยังต่ออยู่กลับเข้าคิว (game-rules.md ข้อ 6)
 * เรียกจาก `abortRoom()` ผ่าน hook `room.onAbort` เท่านั้น (ADR-039 ข้อ 6)
 */
function requeueFromRoom(io: TypedServer, room: Room): void {
  // เริ่มจับเวลาไปแล้วถือว่าแมตช์เกิดขึ้นจริง ผลถูกตัดสินไปตามกติกาข้อ 6 แล้ว
  if (room.serverStartTs !== null) return;

  const kind: QueueKind = room.roomKind === 'multiplayer' ? 'multiplayer' : 'competitive';
  const now = Date.now();
  const players = [...room.players.values()];
  for (const player of players) {
    const socketId = [...player.sockets][0];
    if (socketId === undefined) continue;

    // "คู่ล่าสุด" มีความหมายเฉพาะห้อง 1v1 — ห้องหลายคนไม่มีคู่ต่อสู้คนเดียวให้จำ
    const opponent =
      players.length === 2 ? players.find((other) => other.userId !== player.userId) : undefined;
    requeue(
      io,
      {
        userId: player.userId,
        socketId,
        cubeType: room.cubeType,
        kind,
        username: player.username,
        nickname: player.nickname,
        eloRating: player.eloRating,
        queuedAtTs: now,
        lastOpponentId: null,
        statusSent: 0,
      },
      // คู่ที่เพิ่งหลุดถือเป็น "คู่ล่าสุด" จะได้ไม่ถูกจับกลับไปหาคนเดิมทันทีถ้ามีตัวเลือกอื่น
      opponent?.userId ?? null,
    );
  }
}
