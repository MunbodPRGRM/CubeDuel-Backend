import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';

/**
 * ตั้ง Socket.IO — รายละเอียด event ทั้งหมดอยู่ใน docs/socket-events.md
 * หลักการที่ห้ามละเมิด: state เป็นของ server, เวลาใช้ของ server,
 * ใช้ socket.data.userId เสมอ, ส่ง endsAtTs ไม่ใช่จำนวนวินาทีที่เหลือ
 */
export function createSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.corsOrigin, credentials: true },
  });

  // TODO(เฟส 4): middleware ตรวจ JWT ตอน handshake -> socket.data.userId
  // TODO(เฟส 4): net:ping, room:create, room:join, state machine

  return io;
}
