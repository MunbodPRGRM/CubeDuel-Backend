import type { TypedServer } from './ack.js';
import { roomCount } from './room-registry.js';

/**
 * ตัวเลข "ตอนนี้ในระบบมีอะไรอยู่บ้าง" สำหรับแดชบอร์ดแอดมิน (api-contract.md ข้อ 9)
 *
 * ทั้งสองค่ามาจาก **memory ของ Socket.IO** ไม่ใช่จาก DB — ไม่มีตาราง session ให้ query
 * และไม่ควรมี เพราะสถานะ "ออนไลน์อยู่ไหม" เปลี่ยนทุกวินาที (ADR-034 ข้อ 1: process เดียว instance เดียว)
 *
 * ชั้น REST เข้าถึง `io` ตรง ๆ ไม่ได้ (คนละไฟล์ คนละวงจรชีวิต) จึงฝากตัว server ไว้ที่นี่ตอนสร้าง
 * แล้วให้ service ของแอดมินอ่านผ่านฟังก์ชันสองตัวนี้แทน
 */
let server: TypedServer | null = null;

export function registerSocketServer(io: TypedServer): void {
  server = io;
}

/** ใช้ในเทส — ล้างตัวที่ฝากไว้ทิ้ง */
export function clearSocketServer(): void {
  server = null;
}

/**
 * จำนวน **ผู้ใช้** (ไม่ใช่จำนวน socket) ที่เชื่อมต่ออยู่ตอนนี้
 *
 * คนเดียวเปิดสองแท็บ = 2 socket แต่ต้องนับเป็น 1 → นับ `userId` ที่ไม่ซ้ำกัน
 * ยังไม่มี server = 0 (เช่นตอนรันเทสที่ไม่ได้เปิด socket)
 */
export function onlineUserCount(): number {
  if (!server) return 0;
  const users = new Set<number>();
  for (const socket of server.sockets.sockets.values()) {
    if (socket.data.userId) users.add(socket.data.userId);
  }
  return users.size;
}

/** ห้องที่ยังมีชีวิตอยู่ใน registry (รวมห้องฝึกซ้อม/ห้องที่รอคนเข้า) */
export function activeRoomCount(): number {
  return roomCount();
}
