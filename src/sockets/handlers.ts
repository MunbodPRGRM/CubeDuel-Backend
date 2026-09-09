/**
 * ผูก handler ของทุก event เข้ากับ socket หนึ่งตัว
 *
 * event ทั้งหมดมาจาก `docs/socket-events.md` — ห้ามเพิ่มชื่อ event ที่นี่โดยไม่แก้เอกสารก่อน
 * ทุกตัวใช้ `socket.data.userId` เท่านั้น ห้ามเชื่อ `userId` ที่มาใน payload
 */
import {
  emptyPayloadSchema,
  netPingSchema,
  queueJoinSchema,
  roomCreateSchema,
  roomJoinSchema,
  roomReadySchema,
  roomRejoinSchema,
  solveMoveSchema,
  solveSolvedSchema,
} from '../schemas/socket.schema.js';
import { on, type TypedServer, type TypedSocket } from './ack.js';
import { socketErrors } from './errors.js';
import { handleMove, handleSolved, handleSurrender, markLoaded, startMatch } from './match.js';
import { joinQueue, leaveQueue } from './queue.js';
import { createRoom, getRoom, getRoomByCode, membershipOf } from './room-registry.js';
import type { Room } from './room.js';
import {
  broadcastState,
  emitToRoom,
  joinAsPlayer,
  joinAsSpectator,
  leavePreviousRoom,
  leaveRoom,
} from './room-service.js';

/** เพดานของ RTT ที่ยอมรับจาก client — สูงกว่านี้ถือว่าเน็ตเสียหรือค่าปลอม */
const MAX_REPORTED_RTT_MS = 1_000;

/** ห้องที่ socket นี้อยู่ — ทุก event ของการแข่งต้องผ่านตัวนี้ก่อน */
function requireRoom(socket: TypedSocket): Room {
  const membership = membershipOf(socket.data.userId);
  if (!membership) throw socketErrors.roomNotFound('ยังไม่ได้อยู่ในห้องไหน');
  return membership.room;
}

export function registerHandlers(io: TypedServer, socket: TypedSocket): void {
  // ---------------------------------------------------------------- net

  /**
   * วัด latency + sync นาฬิกา (socket-events.md ข้อ 2)
   * client คำนวณ RTT เองแล้วรายงานกลับมาในครั้งถัดไป — server เอาไปชดเชยเวลา
   * ได้ไม่เกิน 150 ms อยู่ดี จึงปลอมให้ได้เปรียบไม่ได้ (game-rules.md ข้อ 3)
   */
  on(socket, 'net:ping', netPingSchema, (socket, payload) => {
    if (payload.lastRttMs !== undefined) {
      socket.data.rttMs = Math.min(Math.max(payload.lastRttMs, 0), MAX_REPORTED_RTT_MS);
    }
    return { serverTs: Date.now(), clientTs: payload.clientTs };
  });

  // ---------------------------------------------------------------- คิวจับคู่

  /** เข้าคิวหาคู่ — หนึ่งคนอยู่ได้ช่องเดียว และเข้าคิวพร้อมกับอยู่ในห้องไม่ได้ (ADR-039 ข้อ 1) */
  on(socket, 'queue:join', queueJoinSchema, (socket, payload) => joinQueue(io, socket, payload));

  on(socket, 'queue:leave', emptyPayloadSchema, (socket) => ({
    left: leaveQueue(socket.data.userId),
  }));

  // ---------------------------------------------------------------- ห้อง

  on(socket, 'room:create', roomCreateSchema, async (socket, payload) => {
    leavePreviousRoom(io, socket);
    const room = createRoom({
      // `competitive` ผ่าน schema มาได้เฉพาะตอนเปิดสวิตช์ทดสอบบนเครื่อง dev (ADR-038)
      roomKind: payload.kind === 'competitive' ? 'competitive' : 'custom',
      // roomMode มีความหมายเฉพาะห้องผู้เล่นหลายคน — ห้อง 1v1 เป็น null เสมอ
      roomMode: null,
      cubeType: payload.cubeType,
      maxPlayers: payload.maxPlayers,
      // ห้องแข่งขันจริงไม่มีรหัส แต่ห้องทดสอบต้องมี ไม่งั้นอีกฝั่งเข้าไม่ได้
      withCode: true,
    });
    await joinAsPlayer(io, socket, room);
    return { roomId: room.roomId, roomCode: room.roomCode! };
  });

  on(socket, 'room:join', roomJoinSchema, async (socket, payload) => {
    const room = getRoomByCode(payload.roomCode);
    if (!room) throw socketErrors.roomNotFound();

    leavePreviousRoom(io, socket, room.roomId);
    if (payload.as === 'spectator') await joinAsSpectator(io, socket, room);
    else await joinAsPlayer(io, socket, room);

    return { snapshot: room.snapshot() };
  });

  /** reconnect — ที่นั่งยังอยู่เพราะผูกกับ userId ไม่ใช่ socket (ADR-034 ข้อ 3) */
  on(socket, 'room:rejoin', roomRejoinSchema, async (socket, payload) => {
    const room = getRoom(payload.roomId);
    if (!room) throw socketErrors.roomNotFound('ห้องนี้ถูกยุบไปแล้ว');

    const membership = membershipOf(socket.data.userId);
    if (!membership || membership.roomId !== room.roomId) {
      throw socketErrors.roomNotFound('ไม่ได้อยู่ในห้องนี้ ต้องเข้าใหม่ด้วยรหัสห้อง');
    }

    if (membership.seat === 'spectator') await joinAsSpectator(io, socket, room);
    else await joinAsPlayer(io, socket, room);

    return { snapshot: room.snapshot() };
  });

  on(socket, 'room:leave', emptyPayloadSchema, (socket) => {
    leaveRoom(io, socket, 'left');
    return null;
  });

  on(socket, 'room:ready', roomReadySchema, (socket, payload) => {
    const membership = membershipOf(socket.data.userId);
    const room = membership?.room;
    if (!room || membership.seat !== 'player') {
      throw socketErrors.invalidState('ต้องอยู่ในห้องในฐานะผู้เล่นก่อน');
    }
    if (room.state !== 'WAITING') throw socketErrors.invalidState('ห้องนี้เริ่มแข่งไปแล้ว');

    const player = room.players.get(socket.data.userId);
    if (!player) throw socketErrors.invalidState('ไม่พบที่นั่งของผู้เล่นในห้องนี้');

    player.isReady = payload.ready;
    room.touch();
    emitToRoom(io, room, 'room:ready_changed', {
      userId: player.userId,
      ready: player.isReady,
    });
    broadcastState(io, room);
    return null;
  });

  // ---------------------------------------------------------------- ลำดับการแข่ง

  on(socket, 'room:start', emptyPayloadSchema, async (socket) => {
    await startMatch(io, requireRoom(socket), socket.data.userId);
    return null;
  });

  on(socket, 'solve:ready', emptyPayloadSchema, (socket) => {
    markLoaded(io, requireRoom(socket), socket.data.userId);
    return null;
  });

  // ไม่มี ack — client ส่งแล้วไปต่อเลย ผิดเมื่อไรได้ event `error` กลับไป
  on(socket, 'solve:move', solveMoveSchema, (socket, payload) => {
    handleMove(io, socket, requireRoom(socket), payload);
    return null;
  });

  on(socket, 'solve:solved', solveSolvedSchema, (socket, payload) =>
    handleSolved(io, socket, requireRoom(socket), payload),
  );

  on(socket, 'solve:surrender', emptyPayloadSchema, (socket) => {
    handleSurrender(io, requireRoom(socket), socket.data.userId);
    return null;
  });
}
