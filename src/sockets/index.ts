import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { disposeLimiter, type TypedServer, type TypedSocket } from './ack.js';
import { authMiddleware } from './auth.js';
import { registerHandlers } from './handlers.js';
import { findExpiredRooms, ROOM_IDLE_TIMEOUT_MS } from './room-registry.js';
import { abortRoom, leaveRoom } from './room-service.js';

/** ความถี่ที่ไล่เก็บห้องร้าง (ยุบเมื่อไม่มีความเคลื่อนไหวเกิน 30 นาที — game-rules.md ข้อ 9) */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * ตั้ง Socket.IO — รายละเอียด event ทั้งหมดอยู่ใน docs/socket-events.md
 * หลักการที่ห้ามละเมิด: state เป็นของ server, เวลาใช้ของ server,
 * ใช้ socket.data.userId เสมอ, ส่ง endsAtTs ไม่ใช่จำนวนวินาทีที่เหลือ
 *
 * โครงสร้างภายใน (ADR-034): `auth.ts` handshake · `ack.ts` ห่อทุก handler ·
 * `room.ts` + `room-registry.ts` เก็บห้องใน memory · `room-service.ts` เข้า/ออกห้อง
 */
export function createSocketServer(httpServer: HttpServer): TypedServer {
  const io: TypedServer = new Server(httpServer, {
    cors: { origin: env.corsOrigin, credentials: true },
  });

  io.use((socket, next) => authMiddleware(socket as TypedSocket, next));

  io.on('connection', (socket) => {
    registerHandlers(io, socket);

    socket.on('disconnect', () => {
      leaveRoom(io, socket, 'disconnected');
      disposeLimiter(socket);
    });
  });

  const sweeper = setInterval(() => {
    for (const room of findExpiredRooms()) {
      abortRoom(io, room, 'timeout', 'ห้องนี้ไม่มีความเคลื่อนไหวนานเกินไป จึงถูกยุบอัตโนมัติ');
    }
  }, SWEEP_INTERVAL_MS);
  // ไม่ให้ตัวจับเวลาค้าง event loop ตอนสั่งปิด process
  sweeper.unref();

  console.log(
    `[cubeduel] socket.io พร้อมใช้งาน (ยุบห้องร้างทุก ${ROOM_IDLE_TIMEOUT_MS / 60_000} นาที)`,
  );
  return io;
}
