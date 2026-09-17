/**
 * ตรรกะเข้า/ออกห้อง — ใช้ร่วมกันระหว่าง handler ปกติกับตอน `disconnect`
 *
 * กติกา: `docs/game-rules.md` ข้อ 9 (ห้องสร้างเอง · ผู้ชม · การโอน host)
 * ทุกฟังก์ชันในไฟล์นี้ **แก้ทะเบียนห้องกับ Socket.IO room ให้ครบพร้อมกันเสมอ**
 * ห้ามมีที่ไหนเรียก `socket.join()` เองนอกไฟล์นี้
 */
import { prisma } from '../lib/prisma.js';
import { CUBE_TYPE_TO_PRISMA } from '../types/cube.js';
import { ELO_INITIAL_RATING } from '../constants.js';
import type { TypedServer, TypedSocket } from './ack.js';
import { socketErrors } from './errors.js';
import { MAX_SPECTATORS, type Room } from './room.js';
import { clearMembership, disposeRoom, membershipOf, setMembership } from './room-registry.js';
import {
  ACTIVE_STATES,
  playerRoomName,
  spectatorRoomName,
  type AbortReason,
  type LeaveReason,
  type Seat,
  type ServerToClientEvents,
} from './types.js';

/** ผู้เล่นที่เพิ่งเสีย socket ตัวสุดท้ายไป — ผู้เรียก `leaveRoom` เอาไปเริ่มนับ grace ต่อ */
export interface DisconnectedPlayer {
  room: Room;
  userId: number;
}

/** ห้องนี้กำลังแข่งอยู่ไหม — ใช้ตัดสินว่าออกจากห้องกลางคันได้หรือเปล่า */
export function isRoomActive(room: Room): boolean {
  return ACTIVE_STATES.includes(room.state);
}

/** ส่ง event ให้ทั้งผู้เล่นและผู้ชมของห้อง (คนที่อยู่ทั้งสองฝั่งได้ชุดเดียว) */
export function emitToRoom<E extends keyof ServerToClientEvents>(
  io: TypedServer,
  room: Room,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  io.to(playerRoomName(room.roomId))
    .to(spectatorRoomName(room.roomId))
    .emit(event, ...args);
}

/** ส่ง snapshot ล่าสุดให้ทุกคนในห้อง — เรียกทุกครั้งที่สิ่งที่เห็นบนจอเปลี่ยน */
export function broadcastState(io: TypedServer, room: Room): void {
  emitToRoom(io, room, 'room:state', room.snapshot());
}

/** Elo ของประเภทที่ห้องนี้แข่ง (Rating แยก 4 แถวต่อคน — ไม่ได้อยู่ในตาราง User) */
export async function eloOf(userId: number, cubeType: Room['cubeType']): Promise<number> {
  const rating = await prisma.rating.findUnique({
    where: { userId_cubeType: { userId, cubeType: CUBE_TYPE_TO_PRISMA[cubeType] } },
    select: { eloRating: true },
  });
  // ผู้ใช้ทุกคนต้องมีครบ 4 แถวตั้งแต่สมัคร — ถ้าหายแปลว่าข้อมูลเพี้ยน ใช้ค่าเริ่มต้นไปก่อน
  return rating?.eloRating ?? ELO_INITIAL_RATING;
}

// ---------------------------------------------------------------- เข้าห้อง

/**
 * ผู้ใช้อยู่ได้ทีละหนึ่งห้อง (ADR-034 ข้อ 4)
 * ห้องเก่ายังไม่เริ่มแข่ง → พาออกให้เอง · กำลังแข่งอยู่ → ห้ามย้าย
 */
export function leavePreviousRoom(io: TypedServer, socket: TypedSocket, keepRoomId?: number): void {
  const current = membershipOf(socket.data.userId);
  if (!current) return;
  // เข้าห้องเดิมซ้ำ (กด join ด้วยรหัสห้องที่อยู่แล้ว / reconnect) — ไม่ต้องพาออกก่อน
  if (current.roomId === keepRoomId) return;
  if (current.seat === 'player' && isRoomActive(current.room)) {
    throw socketErrors.invalidState(
      'ยังอยู่ในห้องที่กำลังแข่งอยู่ ต้องออกหรือยอมแพ้ในห้องนั้นก่อน',
    );
  }
  leaveRoom(io, socket, 'left');
}

export async function joinAsPlayer(
  io: TypedServer,
  socket: TypedSocket,
  room: Room,
): Promise<void> {
  const { userId } = socket.data;
  let player = room.players.get(userId);

  if (!player) {
    if (room.isFull) throw socketErrors.roomFull('ห้องนี้มีผู้เล่นครบแล้ว');
    if (isRoomActive(room)) {
      throw socketErrors.invalidState('ห้องนี้เริ่มแข่งไปแล้ว เข้าร่วมได้เฉพาะในฐานะผู้ชม');
    }
    player = room.addPlayer({
      userId,
      username: socket.data.username,
      nickname: socket.data.nickname,
      eloRating: await eloOf(userId, room.cubeType),
    });
    emitToRoom(io, room, 'room:player_joined', { player: room.toPublicPlayer(player) });
  }

  const wasDisconnected = player.sockets.size === 0;
  player.sockets.add(socket.id);
  socket.data.roomId = room.roomId;
  socket.data.seat = 'player';
  setMembership(userId, room.roomId, 'player');
  await socket.join(playerRoomName(room.roomId));
  room.touch();

  // กลับมาทันภายใน grace → ยกเลิกตัวนับ แล้วบอกทั้งห้องว่ากลับมาแล้ว (game-rules.md ข้อ 6)
  if (wasDisconnected) cancelDisconnectGrace(io, room, userId);
  broadcastState(io, room);
}

/**
 * ยกเลิก grace ของผู้เล่นที่กลับมาแล้ว
 *
 * อยู่ที่ไฟล์นี้ (ไม่ใช่ `match.ts`) เพราะเป็นแค่การล้างตัวจับเวลา ไม่มีตรรกะของแมตช์
 * — ถ้าย้ายไปฝั่งโน้นจะกลายเป็น import วนกันสองไฟล์
 */
export function cancelDisconnectGrace(io: TypedServer, room: Room, userId: number): void {
  const timer = room.graceTimers.get(userId);
  if (!timer) return;
  clearTimeout(timer);
  room.graceTimers.delete(userId);
  emitToRoom(io, room, 'player:reconnected', { userId });
}

export async function joinAsSpectator(
  io: TypedServer,
  socket: TypedSocket,
  room: Room,
): Promise<void> {
  const { userId } = socket.data;
  // ผู้ชมมีได้ทุกห้องที่มีรหัสห้อง (1v1 + หลายคนโหมด custom — ADR-079) · ห้องจากคิวไม่มีรหัส
  // จึงมาทาง `room:join` ไม่ได้อยู่แล้ว ด่านนี้กันทาง `room:rejoin` กับโค้ดในอนาคต
  if (room.roomCode === null) {
    throw socketErrors.invalidState('ห้องที่มาจากการจับคู่ไม่รองรับผู้ชม');
  }
  const isNew = !room.spectators.has(userId);
  if (isNew && room.spectatorCount >= MAX_SPECTATORS) {
    throw socketErrors.roomFull(`ห้องนี้มีผู้ชมครบ ${MAX_SPECTATORS} คนแล้ว`);
  }

  room.addSpectatorSocket(
    { userId, username: socket.data.username, nickname: socket.data.nickname },
    socket.id,
  );
  socket.data.roomId = room.roomId;
  socket.data.seat = 'spectator';
  setMembership(userId, room.roomId, 'spectator');
  await socket.join(spectatorRoomName(room.roomId));

  if (isNew) emitToRoom(io, room, 'room:spectator_count', { count: room.spectatorCount });
  broadcastState(io, room);
}

// ---------------------------------------------------------------- สลับที่นั่ง

/** state ที่สลับผู้เล่น ↔ ผู้ชมได้ — ระหว่างแข่งผู้เล่นสลับเป็นผู้ชม = หนีผลแพ้ (ADR-082 ข้อ 2) */
function canSwitchSeat(room: Room): boolean {
  return room.state === 'WAITING' || room.state === 'FINISHED';
}

/**
 * ย้าย socket ทั้งชุดของคนหนึ่งไปอีก Socket.IO room ของห้องเดิม พร้อมอัปเดต `socket.data`
 * ต้องย้าย **ทุกแท็บ** ไม่งั้นแท็บที่ค้างฝั่งเดิมได้ event ผิดชุด (ADR-082 ข้อ 1)
 */
async function moveSockets(
  io: TypedServer,
  room: Room,
  socketIds: Iterable<string>,
  to: Seat,
): Promise<void> {
  const [from, into] =
    to === 'player'
      ? [spectatorRoomName(room.roomId), playerRoomName(room.roomId)]
      : [playerRoomName(room.roomId), spectatorRoomName(room.roomId)];
  for (const socketId of socketIds) {
    const target = io.sockets.sockets.get(socketId);
    if (!target) continue;
    await target.leave(from);
    await target.join(into);
    target.data.roomId = room.roomId;
    target.data.seat = to;
  }
}

/**
 * `room:switch_seat` — สลับผู้เล่น ↔ ผู้ชมในห้องเดิม (ADR-082 · game-rules.md ข้อ 9)
 *
 * **ไม่ใช่ leave + join** — สิทธิ์หัวห้องไม่หลุด ห้องไม่ยุบ และไม่มีช่วงที่หลุดจากห้องให้คนอื่นแย่งที่นั่ง
 * socket ที่สั่งถูกย้ายด้วยเสมอ แม้ยังไม่เคยเข้าห้องนี้ (แท็บใหม่ที่มาทาง `room:join`)
 * ผู้เรียกเป็นคนตอบ snapshot กลับเอง
 */
export async function switchSeat(io: TypedServer, socket: TypedSocket, to: Seat): Promise<Room> {
  const { userId } = socket.data;
  const membership = membershipOf(userId);
  if (!membership) throw socketErrors.roomNotFound('ยังไม่ได้อยู่ในห้องไหน');
  const { room } = membership;

  if (room.roomCode === null) {
    throw socketErrors.invalidState('ห้องที่มาจากการจับคู่สลับผู้เล่น/ผู้ชมไม่ได้');
  }
  // กดพร้อมกันสองแท็บ / ปุ่มค้างจาก snapshot เก่า — ไม่ใช่ความผิดพลาด
  if (membership.seat === to) return room;
  if (!canSwitchSeat(room)) {
    throw socketErrors.invalidState('สลับผู้เล่น/ผู้ชมได้เฉพาะก่อนเริ่มหรือหลังจบรอบ');
  }

  if (to === 'spectator') {
    const player = room.players.get(userId);
    if (!player) throw socketErrors.invalidState('ไม่พบที่นั่งของผู้เล่นในห้องนี้');
    if (room.spectatorCount >= MAX_SPECTATORS) {
      throw socketErrors.roomFull(`ห้องนี้มีผู้ชมครบ ${MAX_SPECTATORS} คนแล้ว`);
    }

    // socket ที่สั่งยังต่ออยู่ grace จึงไม่ควรมี — เผื่อแท็บเก่าหลุดหมดแล้วแท็บใหม่สั่งตรง ๆ
    const timer = room.graceTimers.get(userId);
    if (timer) clearTimeout(timer);
    room.graceTimers.delete(userId);

    // ไม่ใช่การออกจากห้อง → ไม่ส่ง `room:player_left` และไม่แตะสิทธิ์หัวห้อง (ADR-082 ข้อ 1, 3)
    room.removePlayer(userId);
    const socketIds = new Set([...player.sockets, socket.id]);
    for (const socketId of socketIds) {
      room.addSpectatorSocket(
        { userId, username: player.username, nickname: player.nickname },
        socketId,
      );
    }
    setMembership(userId, room.roomId, 'spectator');
    await moveSockets(io, room, socketIds, 'spectator');
  } else {
    if (room.isFull) throw socketErrors.roomFull('ห้องนี้มีผู้เล่นครบแล้ว');
    const eloRating = await eloOf(userId, room.cubeType);

    // ระหว่าง await อาจมีคนเข้ามาจนเต็ม / เริ่มรอบ / แท็บอื่นของเราสลับไปก่อนแล้ว
    const current = membershipOf(userId);
    if (current?.roomId !== room.roomId) throw socketErrors.roomNotFound('ไม่ได้อยู่ในห้องนี้แล้ว');
    if (current.seat === 'player') return room;
    if (!canSwitchSeat(room)) throw socketErrors.invalidState('ห้องนี้เริ่มแข่งไปแล้ว');
    if (room.isFull) throw socketErrors.roomFull('ห้องนี้มีผู้เล่นครบแล้ว');

    const spectator = room.spectators.get(userId);
    const socketIds = new Set([...(spectator?.sockets ?? []), socket.id]);
    room.removeSpectator(userId);
    const player = room.addPlayer({
      userId,
      username: spectator?.username ?? socket.data.username,
      nickname: spectator?.nickname ?? socket.data.nickname,
      eloRating,
    });
    for (const socketId of socketIds) player.sockets.add(socketId);
    setMembership(userId, room.roomId, 'player');
    await moveSockets(io, room, socketIds, 'player');
    emitToRoom(io, room, 'room:player_joined', { player: room.toPublicPlayer(player) });
  }

  room.touch();
  emitToRoom(io, room, 'room:spectator_count', { count: room.spectatorCount });
  broadcastState(io, room);
  return room;
}

// ---------------------------------------------------------------- ออกจากห้อง

/**
 * ถอด socket ที่ระบุออกจาก Socket.IO room ของห้องนี้ พร้อมล้าง `socket.data`
 *
 * ต้องทำกับ **ทุก socket ของผู้ใช้คนนั้น** ตอนออกจากห้องแบบตั้งใจ ไม่ใช่แค่ตัวที่กดออก
 * ไม่งั้นแท็บที่เหลือจะค้างอยู่ใน Socket.IO room ทั้งที่ไม่มีที่นั่งแล้ว
 */
function detachSockets(io: TypedServer, room: Room, socketIds: Iterable<string>): void {
  for (const socketId of socketIds) {
    const target = io.sockets.sockets.get(socketId);
    if (!target) continue;
    void target.leave(playerRoomName(room.roomId));
    void target.leave(spectatorRoomName(room.roomId));
    target.data.roomId = null;
    target.data.seat = null;
  }
}

export function abortRoom(io: TypedServer, room: Room, reason: AbortReason, message: string): void {
  room.state = 'ABORTED';
  emitToRoom(io, room, 'room:aborted', { reason, message });
  for (const player of room.players.values()) detachSockets(io, room, player.sockets);
  for (const spectator of room.spectators.values()) detachSockets(io, room, spectator.sockets);
  io.socketsLeave(playerRoomName(room.roomId));
  io.socketsLeave(spectatorRoomName(room.roomId));
  disposeRoom(room);

  /**
   * งานเก็บกวาดของคนสร้างห้อง — ตอนนี้มีที่เดียวคือคิวจับคู่ ที่ต้องส่งคนที่ยังต่ออยู่
   * กลับเข้าคิว (ADR-039 ข้อ 6) · เรียก **หลัง** `disposeRoom` เพื่อให้ membership ถูกล้างก่อน
   * ล้มที่ hook ต้องไม่ทำให้การยุบห้องซึ่งทำไปเรียบร้อยแล้วพังตาม
   */
  try {
    room.onAbort?.(room);
  } catch (error) {
    console.error(`[socket] onAbort ของห้อง ${room.roomId} ล้มเหลว`, error);
  }
}

/**
 * เอาผู้ใช้ออกจากห้อง
 *
 * `reason = 'disconnected'` คิดเป็นราย socket — เหลืออีกแท็บอยู่ก็ยังไม่หลุดห้อง
 * เหตุผลอื่น ('left' / 'kicked') คิดเป็นรายคน — ถอดทุก socket ของคนนั้นออกพร้อมกัน
 * (ตัวตนในห้องคือ `userId` ไม่ใช่ socket — ADR-034 ข้อ 3)
 *
 * **ยึดห้องจาก membership ไม่ใช่ `socket.data.roomId`** เพราะ socket ที่สั่งอาจยังไม่เคยเข้าห้องนั้น
 * (เช่นเปิดแท็บใหม่แล้วสั่ง `room:join` ทั้งที่แท็บเดิมยังอยู่ในอีกห้อง)
 */
export function leaveRoom(
  io: TypedServer,
  socket: TypedSocket,
  reason: LeaveReason,
): DisconnectedPlayer | null {
  const { userId } = socket.data;
  const membership = membershipOf(userId);
  socket.data.roomId = null;
  socket.data.seat = null;
  if (!membership) return null;

  const { room } = membership;
  const player = room.players.get(userId);

  if (player) {
    if (reason === 'disconnected') {
      player.sockets.delete(socket.id);
      detachSockets(io, room, [socket.id]);
      // ปิดไปแค่แท็บเดียว ยังมีแท็บอื่นอยู่ → ยังไม่ถือว่าออกจากห้อง
      if (player.sockets.size > 0) return null;
      broadcastState(io, room);
      // ผู้เรียกเป็นคนเริ่มนับ grace เอง (ไม่ทำที่นี่เพื่อไม่ให้ import วนกับ match.ts)
      return { room, userId };
    }

    if (isRoomActive(room)) {
      // ออกกลางแมตช์ไม่ได้ ไม่งั้นจะใช้หนีผลแพ้ได้ — ต้องกด "ยอมแพ้" แล้วรอผล (ADR-035 ข้อ 10)
      throw socketErrors.invalidState(
        'ระหว่างแข่งออกจากห้องไม่ได้ ถ้าไม่เล่นต่อให้กด "ยอมแพ้" แล้วรอผลการแข่งขัน',
      );
    }

    detachSockets(io, room, [socket.id]);
    removePlayerFromRoom(io, room, userId, reason);
    return null;
  }

  // ผู้ชม
  const spectator = room.spectators.get(userId);
  if (!spectator) return null;

  if (reason === 'disconnected') {
    detachSockets(io, room, [socket.id]);
    // คืน false = ยังมีแท็บอื่นดูอยู่ → ยังไม่ถือว่าออกจากห้อง
    if (!room.removeSpectatorSocket(userId, socket.id)) return null;
  } else {
    detachSockets(io, room, [...spectator.sockets, socket.id]);
    room.removeSpectator(userId);
  }

  clearMembership(userId);
  if (room.isEmpty) {
    disposeRoom(room);
    return null;
  }
  emitToRoom(io, room, 'room:spectator_count', { count: room.spectatorCount });

  // หัวห้องที่นั่งเป็นผู้ชมออก → โอนสิทธิ์ · `host` ใน snapshot เปลี่ยน จึงต้องส่ง state ตาม (ADR-082 ข้อ 3)
  const newHost = room.reassignHostIfNeeded();
  if (newHost !== null) {
    emitToRoom(io, room, 'room:host_changed', { newHostUserId: newHost });
    broadcastState(io, room);
  }
  return null;
}

/**
 * ถอดผู้เล่นออกจากห้องทั้งคน — ใช้ทั้งตอนกดออกเองและตอนหลุดการเชื่อมต่อจนหมด grace
 * (ไม่ต้องมี socket ก็เรียกได้ เพราะคนที่หลุดไปแล้วไม่เหลือ socket ให้อ้าง)
 */
export function removePlayerFromRoom(
  io: TypedServer,
  room: Room,
  userId: number,
  reason: LeaveReason,
): void {
  const player = room.players.get(userId);
  if (!player) return;

  const timer = room.graceTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    room.graceTimers.delete(userId);
  }

  room.removePlayer(userId);
  if (membershipOf(userId)?.roomId === room.roomId) clearMembership(userId);
  // ส่งก่อนถอด socket เพื่อให้แท็บอื่นของคนที่ออกรู้ด้วยว่าไม่ได้อยู่ในห้องแล้ว
  emitToRoom(io, room, 'room:player_left', { userId, reason });
  detachSockets(io, room, player.sockets);

  // host คนใหม่อาจเป็นผู้ชมได้ถ้าไม่มีผู้เล่นเหลือ (ADR-082 ข้อ 3)
  const newHost = room.reassignHostIfNeeded();
  if (newHost !== null) emitToRoom(io, room, 'room:host_changed', { newHostUserId: newHost });

  // ยุบเมื่อไม่เหลือใครเลยเท่านั้น — ห้องที่เหลือแต่ผู้ชมอยู่ต่อได้ (ADR-082 ข้อ 4)
  // ห้องจากคิวไม่มีผู้ชม เงื่อนไขนี้จึงเท่ากับ "ผู้เล่นเหลือ 0" แบบเดิม
  if (room.isEmpty) {
    abortRoom(io, room, 'host_left', 'ไม่มีใครเหลืออยู่ในห้องแล้ว');
    return;
  }
  broadcastState(io, room);
}
