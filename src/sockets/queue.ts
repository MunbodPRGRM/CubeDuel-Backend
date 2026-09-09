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
 */
import {
  MATCHED_DELAY_MS,
  MULTIPLAYER_ROOM_MIN,
  QUEUE_STATUS_INTERVAL_MS,
  QUEUE_TICK_MS,
  QUEUE_TIMEOUT_MS,
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
  QueueJoinPayload,
  QueueJoinResult,
  QueueKind,
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
  const waitedMs = now - entry.queuedAtTs;
  socketOf(io, entry)?.emit('queue:status', {
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

/**
 * ถอนทุกคนในกลุ่มออกจากคิวแล้วเปิดห้องให้
 * คืนโดยไม่ทำอะไรถ้ามีใครหลุดออกจากคิวไประหว่างนี้ (คนที่เหลือรอ tick ถัดไปเอง)
 */
function takeGroup(io: TypedServer, userIds: readonly number[]): void {
  const entries = userIds.map((userId) => queue.get(userId));
  if (entries.some((entry) => entry === undefined)) return;

  const group = entries as QueueEntry[];
  for (const entry of group) queue.delete(entry.userId);
  void openMatchedRoom(io, group);
}

/** กวาดคิวหนึ่งรอบ: จับคู่/จับกลุ่มก่อน แล้วค่อยแจ้งสถานะ/หมดเวลาให้คนที่ยังรออยู่ */
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
    // ทุกคนในช่องเดียวกันมี kind เท่ากันเสมอ (slotKey ประกอบด้วย kind)
    if (entries[0]?.kind === 'multiplayer') {
      for (const group of groupUp(entries, now)) {
        takeGroup(
          io,
          group.map((waiter) => waiter.userId),
        );
      }
    } else {
      for (const pair of pairUp(entries, now)) {
        takeGroup(io, [pair.a.userId, pair.b.userId]);
      }
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

  // หน่วงให้ดูข้อมูลคู่แข่ง 2 วินาทีแล้วเข้า LOADING เอง (game-rules.md ข้อ 1)
  room.phaseTimer = setTimeout(() => void startMatchedRoom(io, room), MATCHED_DELAY_MS);
}

/**
 * คนที่หลุดไปในช่วง `MATCHED` 2 วินาที — `beginLoading()` ไม่ยอมเริ่มถ้ายังมีที่นั่งที่ไม่มี socket
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

/** ครบ 2 วินาทีหลัง `MATCHED` — เริ่มแมตช์ให้เอง ไม่มีใครต้องกดปุ่ม */
async function startMatchedRoom(io: TypedServer, room: Room): Promise<void> {
  if (room.state !== 'MATCHED') return;
  room.clearPhaseTimer();
  dropDisconnectedBeforeStart(io, room);

  try {
    await beginLoading(io, room);
  } catch (error) {
    // ผู้เล่นหลุดไปในช่วง 2 วินาทีนั้นพอดี — ยุบห้องแล้วส่งคนที่เหลือกลับเข้าคิว
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
