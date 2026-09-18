import type { TypedServer, TypedSocket } from './ack.js';
import { roomCount } from './room-registry.js';

/**
 * ตัวเลข "ตอนนี้ในระบบมีอะไรอยู่บ้าง" — แดชบอร์ดแอดมิน (api-contract.md ข้อ 9)
 * + จำนวน/รายชื่อสมาชิกออนไลน์ที่ผู้ใช้ทุกคนเห็น (ADR-086)
 *
 * ทุกค่ามาจาก **memory ของ Socket.IO** ไม่ใช่จาก DB — ไม่มีตาราง session ให้ query
 * และไม่ควรมี เพราะสถานะ "ออนไลน์อยู่ไหม" เปลี่ยนทุกวินาที (ADR-034 ข้อ 1: process เดียว instance เดียว)
 *
 * ชั้น REST เข้าถึง `io` ตรง ๆ ไม่ได้ (คนละไฟล์ คนละวงจรชีวิต) จึงฝากตัว server ไว้ที่นี่ตอนสร้าง
 * แล้วให้ service อ่านผ่านฟังก์ชันในไฟล์นี้แทน
 */
let server: TypedServer | null = null;

/** `presence:count` ส่งหาทุกคนไม่เกิน 1 ครั้งต่อช่วงนี้ (ADR-086 ข้อ 2) */
export const PRESENCE_BROADCAST_INTERVAL_MS = 5_000;

export function registerSocketServer(io: TypedServer): void {
  server = io;
}

/** ใช้ในเทส — ล้างตัวที่ฝากไว้ทิ้ง */
export function clearSocketServer(): void {
  server = null;
  broadcaster.reset();
}

/**
 * `userId` ที่มี socket ต่ออยู่ตอนนี้ — คนเดียวเปิดสองแท็บ = 2 socket แต่ได้ 1 id
 * ยังไม่มี server = ว่าง (เช่นตอนรันเทสที่ไม่ได้เปิด socket)
 */
export function onlineUserIds(): Set<number> {
  const users = new Set<number>();
  if (!server) return users;
  for (const socket of server.sockets.sockets.values()) {
    if (socket.data.userId) users.add(socket.data.userId);
  }
  return users;
}

/** จำนวน **ผู้ใช้** (ไม่ใช่จำนวน socket) ที่เชื่อมต่ออยู่ตอนนี้ */
export function onlineUserCount(): number {
  return onlineUserIds().size;
}

/**
 * ตัวรวบการกระจายตัวเลข — ขอกี่ครั้งภายในช่วงเดียวกันก็ส่งจริงครั้งเดียวตอนท้ายช่วง (trailing)
 * และ **ส่งเฉพาะเมื่อค่าต่างจากที่ส่งครั้งล่าสุด** (ADR-086 ข้อ 2)
 *
 * ผลคือรีเฟรชหน้า (หลุด −1 แล้วต่อ +1 ภายในไม่กี่ร้อย ms) ไม่มี event ออกไปเลย
 * และคนเข้าออกพร้อมกันเป็นร้อยก็ออกไปแค่ 1 event ต่อ 5 วินาที ไม่ใช่ร้อย event × ทุกคน
 *
 * แยกเป็น factory ที่รับ `read`/`send` เข้ามา เพื่อให้เทสได้โดยไม่ต้องเปิด socket server จริง
 */
export function createThrottledBroadcaster(
  intervalMs: number,
  read: () => number,
  send: (value: number) => void,
) {
  let timer: NodeJS.Timeout | null = null;
  let lastSent: number | null = null;

  return {
    schedule(): void {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const value = read();
        if (value === lastSent) return;
        lastSent = value;
        send(value);
      }, intervalMs);
      // ไม่ให้ตัวจับเวลาค้าง event loop ตอนสั่งปิด process (แบบเดียวกับตัวกวาดห้อง)
      timer.unref();
    },
    reset(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      lastSent = null;
    },
  };
}

const broadcaster = createThrottledBroadcaster(
  PRESENCE_BROADCAST_INTERVAL_MS,
  onlineUserCount,
  (online) => server?.emit('presence:count', { online }),
);

/** มี socket ต่อเข้า/หลุด → นัดกระจายจำนวนใหม่ (ADR-086 ข้อ 2) */
export function schedulePresenceBroadcast(): void {
  broadcaster.schedule();
}

/**
 * ส่งจำนวนปัจจุบันให้ socket ที่เพิ่งต่อ **ตัวเดียว** — ไม่ต้องรอรอบกระจายถัดไป
 * ค่าที่ส่งรวมตัวเองแล้ว เพราะตอน `connection` socket นี้อยู่ในรายการของ server แล้ว
 */
export function sendPresenceTo(socket: TypedSocket): void {
  socket.emit('presence:count', { online: onlineUserCount() });
}

/**
 * ตัดทุก socket ของผู้ใช้คนหนึ่ง เพราะมีการเข้าสู่ระบบใหม่ที่เครื่องอื่น (ADR-076 ข้อ 2)
 *
 * **ไม่ยุ่งกับห้องเอง** — ปล่อยให้ตัวจัดการ disconnect เดิมตัดสินตามกติกาข้อ 6 ของ `game-rules.md`
 * (grace 30 วินาที · เครื่องใหม่ `room:rejoin` ทันก็เล่นต่อได้) ไม่งั้นจะมีกติกา "หลุด" สองชุด
 *
 * ส่ง event ก่อนแล้วค่อยหน่วงสั้น ๆ ก่อนตัดสาย เพื่อให้ packet ออกจากเครื่องทัน —
 * `disconnect(true)` ปิด transport ทันที ถ้าตัดในบรรทัดเดียวกันบางจังหวะ client จะไม่ได้รู้เหตุผล
 * · คืนจำนวน socket ที่ถูกตัด (0 = คนนั้นไม่ได้ออนไลน์อยู่ / ยังไม่มี socket server เช่นตอนรันเทส)
 */
export function revokeUserSockets(userId: number): number {
  if (!server) return 0;
  let kicked = 0;
  for (const socket of server.sockets.sockets.values()) {
    if (socket.data.userId !== userId) continue;
    socket.emit('session:revoked', { reason: 'signed_in_elsewhere' });
    setTimeout(() => socket.disconnect(true), KICK_DELAY_MS);
    kicked += 1;
  }
  return kicked;
}

/** หน่วงสั้น ๆ ให้ `session:revoked` ออกจากเครื่องก่อนปิด transport */
const KICK_DELAY_MS = 50;

/** ห้องที่ยังมีชีวิตอยู่ใน registry (รวมห้องฝึกซ้อม/ห้องที่รอคนเข้า) */
export function activeRoomCount(): number {
  return roomCount();
}
