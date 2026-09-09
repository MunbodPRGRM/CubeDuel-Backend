/**
 * คิวจับคู่อัตโนมัติของห้องแข่งขัน 1v1 — อยู่ใน memory ของ process เดียว เหมือนทะเบียนห้อง
 *
 * กติกา: `docs/game-rules.md` ข้อ 8 (ช่วง Elo ขยายตามเวลารอ · ห้ามเจอคนเดิมซ้ำติดกัน · หมดเวลา 180 วิ)
 * สัญญา event: `docs/socket-events.md` ข้อ 4 · การตัดสินใจที่เอกสารไม่ได้ระบุอยู่ใน ADR-039
 *
 * หลักการของไฟล์นี้:
 *   - **ตรรกะเลือกคู่ไม่อยู่ที่นี่** อยู่ที่ `lib/matchmaking.ts` ซึ่งเป็น pure function มีเทสคุม
 *   - รายการในคิวผูกกับ **socket ที่กดเข้าคิว** — socket นั้นหลุด = ออกจากคิวทันที (ADR-039 ข้อ 1)
 *   - ตัวจับเวลาเปิดตอนมีคนเข้าคิวคนแรก ปิดตอนคิวว่าง (ADR-039 ข้อ 7)
 */
import {
  MATCHED_DELAY_MS,
  QUEUE_STATUS_INTERVAL_MS,
  QUEUE_TICK_MS,
  QUEUE_TIMEOUT_MS,
} from '../constants.js';
import { eloWindowFor, pairUp, type QueueCandidate } from '../lib/matchmaking.js';
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
} from './room-service.js';
import type { Room } from './room.js';
import type { CubeType, QueueJoinPayload, QueueJoinResult, QueueKind } from './types.js';

/** คู่ล่าสุดจำไว้นานเท่านี้ แล้วถือว่าเจอกันใหม่ได้ (ADR-039 ข้อ 4) */
const LAST_OPPONENT_TTL_MS = 30 * 60_000;

interface QueueEntry extends QueueCandidate {
  /** socket ที่กดเข้าคิว — ตัวเดียวเท่านั้นที่ถือคิวนี้ไว้ */
  socketId: string;
  cubeType: CubeType;
  kind: QueueKind;
  /** ส่ง `queue:status` ไปแล้วกี่ครั้ง — ใช้เทียบว่าถึงรอบถัดไปหรือยัง */
  statusSent: number;
}

/** userId → รายการในคิว (หนึ่งคนอยู่ได้ช่องเดียว — ADR-039 ข้อ 1) */
const queue = new Map<number, QueueEntry>();

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
  socketOf(io, entry)?.emit('queue:status', {
    waitedMs: now - entry.queuedAtTs,
    eloWindow: eloWindowFor(now - entry.queuedAtTs),
    playersInQueue: countInSlot(slotKey(entry)),
  });
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
    eloRating,
    queuedAtTs: now,
    lastOpponentId: lastOpponentOf(userId, now),
    statusSent: 0,
  };
  queue.set(userId, entry);
  startTicker(io);

  return { queuedAtTs: now, playersInQueue: countInSlot(slotKey(entry)) };
}

/** `queue:leave` — คืน `false` ถ้าไม่ได้อยู่ในคิวอยู่แล้ว (ไม่ถือว่าผิดพลาด) */
export function leaveQueue(userId: number): boolean {
  const removed = queue.delete(userId);
  stopTickerIfIdle();
  return removed;
}

/** socket หลุด → ออกจากคิวทันที (game-rules.md ข้อ 6) — แท็บอื่นไม่ได้ถือคิวแทน */
export function removeSocketFromQueue(socketId: string): void {
  for (const [userId, entry] of queue) {
    if (entry.socketId === socketId) queue.delete(userId);
  }
  stopTickerIfIdle();
}

/** ไว้ดูตอน debug / เขียนเทส */
export function queueSize(): number {
  return queue.size;
}

/** ใช้ในเทสเท่านั้น — ล้างคิวและตัวจับเวลาทั้งหมด */
export function resetQueue(): void {
  queue.clear();
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

/** กวาดคิวหนึ่งรอบ: จับคู่ก่อน แล้วค่อยแจ้งสถานะ/หมดเวลาให้คนที่ยังรออยู่ */
function tick(io: TypedServer): void {
  const now = Date.now();

  const slots = new Map<string, QueueEntry[]>();
  for (const entry of queue.values()) {
    const key = slotKey(entry);
    const bucket = slots.get(key);
    if (bucket) bucket.push(entry);
    else slots.set(key, [entry]);
  }

  for (const entries of slots.values()) {
    for (const pair of pairUp(entries, now)) {
      const a = queue.get(pair.a.userId);
      const b = queue.get(pair.b.userId);
      if (!a || !b) continue;
      queue.delete(a.userId);
      queue.delete(b.userId);
      void openMatchedRoom(io, a, b);
    }
  }

  for (const entry of [...queue.values()]) {
    const waitedMs = now - entry.queuedAtTs;

    if (waitedMs >= QUEUE_TIMEOUT_MS) {
      queue.delete(entry.userId);
      socketOf(io, entry)?.emit('queue:timeout', { waitedMs });
      continue;
    }
    if (waitedMs >= (entry.statusSent + 1) * QUEUE_STATUS_INTERVAL_MS) {
      entry.statusSent++;
      sendStatus(io, entry, now);
    }
  }

  stopTickerIfIdle();
}

// ---------------------------------------------------------------- เจอคู่แล้ว

/**
 * สร้างห้องแข่งขันของคู่ที่จับได้ แล้วดันทั้งคู่เข้าห้อง
 * ห้องนี้ **ไม่มีรหัสห้อง ไม่มีผู้ชม และกดเริ่มเองไม่ได้** — server เริ่มให้เอง (ADR-039 ข้อ 5)
 */
async function openMatchedRoom(io: TypedServer, a: QueueEntry, b: QueueEntry): Promise<void> {
  const socketA = socketOf(io, a);
  const socketB = socketOf(io, b);

  // อีกฝ่ายเพิ่งหลุดไปพอดี — คนที่ยังอยู่กลับเข้าคิวต่อโดยไม่เสียอะไร
  if (!socketA || !socketB) {
    if (socketA) requeue(io, a);
    if (socketB) requeue(io, b);
    return;
  }

  const room = createRoom({
    roomKind: 'competitive',
    // roomMode มีความหมายเฉพาะห้องผู้เล่นหลายคน — ห้อง 1v1 เป็น null เสมอ
    roomMode: null,
    cubeType: a.cubeType,
    maxPlayers: 2,
    withCode: false,
  });
  // ยุบก่อนเริ่มจับเวลาเมื่อไร คนที่ยังต่ออยู่กลับเข้าคิวเอง (game-rules.md ข้อ 6 · ADR-039 ข้อ 6)
  room.onAbort = (aborted) => requeueFromRoom(io, aborted);

  try {
    await joinAsPlayer(io, socketA, room);
    await joinAsPlayer(io, socketB, room);
  } catch (error) {
    console.error('[queue] พาผู้เล่นเข้าห้องที่จับคู่ได้ไม่สำเร็จ', error);
    abortRoom(io, room, 'player_left', 'เข้าห้องที่จับคู่ได้ไม่สำเร็จ กลับเข้าคิวให้อัตโนมัติ');
    return;
  }

  const now = Date.now();
  rememberOpponents(a.userId, b.userId, now);

  room.state = 'MATCHED';
  room.touch();

  const players = [...room.players.values()].map((player) => room.toPublicPlayer(player));
  for (const socket of [socketA, socketB]) {
    socket.emit('queue:matched', { roomId: room.roomId, cubeType: room.cubeType, players });
  }
  broadcastState(io, room);

  // หน่วงให้ดูข้อมูลคู่แข่ง 2 วินาทีแล้วเข้า LOADING เอง (game-rules.md ข้อ 1)
  room.phaseTimer = setTimeout(() => void startMatchedRoom(io, room), MATCHED_DELAY_MS);
}

/** ครบ 2 วินาทีหลัง `MATCHED` — เริ่มแมตช์ให้เอง ไม่มีใครต้องกดปุ่ม */
async function startMatchedRoom(io: TypedServer, room: Room): Promise<void> {
  if (room.state !== 'MATCHED') return;
  room.clearPhaseTimer();

  try {
    await beginLoading(io, room);
  } catch (error) {
    // ผู้เล่นหลุดไปในช่วง 2 วินาทีนั้นพอดี — ยุบห้องแล้วส่งคนที่เหลือกลับเข้าคิว
    console.error(`[queue] ห้อง ${room.roomId} เริ่มไม่สำเร็จ`, error);
    abortRoom(io, room, 'player_left', 'คู่แข่งหลุดการเชื่อมต่อก่อนเริ่ม กลับเข้าคิวให้อัตโนมัติ');
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

  const now = Date.now();
  const players = [...room.players.values()];
  for (const player of players) {
    const socketId = [...player.sockets][0];
    if (socketId === undefined) continue;

    const opponent = players.find((other) => other.userId !== player.userId);
    requeue(
      io,
      {
        userId: player.userId,
        socketId,
        cubeType: room.cubeType,
        kind: 'competitive',
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
