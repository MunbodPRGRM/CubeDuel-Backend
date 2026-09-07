/**
 * ตรวจ payload ของทุก event ก่อนเข้า handler — ผิดรูปตอบ `E_VALIDATION`
 * รูป payload ต้องตรงกับ `docs/socket-events.md` (แก้เอกสารก่อนเสมอ)
 */
import { z } from 'zod';
import { CUBE_TYPES } from '../types/cube.js';

/** payload ที่ไม่มีฟิลด์อะไรเลย — client บางตัวส่ง `undefined` มา จึงใส่ค่าเริ่มต้นให้ */
export const emptyPayloadSchema = z.object({}).default({});

export const netPingSchema = z.object({
  clientTs: z.number().int().nonnegative(),
  /** RTT ที่ client วัดได้จากการ ping ครั้งก่อน — ครั้งแรกยังไม่มี */
  lastRttMs: z.number().int().nonnegative().optional(),
});

export const roomCreateSchema = z.object({
  cubeType: z.enum(CUBE_TYPES),
  // ห้องหลายคน (`multiplayer`, 3–4 คน) เป็นงานเฟส 6 — ตอนนี้ปฏิเสธตั้งแต่ชั้น schema (ADR-034 ข้อ 10)
  kind: z.enum(['custom', 'multiplayer']).refine((kind) => kind === 'custom', {
    message: 'ตอนนี้เปิดใช้เฉพาะห้องสร้างเอง 1v1 (ห้องผู้เล่นหลายคนยังไม่เปิด)',
  }),
  maxPlayers: z.literal(2, { message: 'ห้องสร้างเองรองรับ 2 คนเท่านั้น' }),
});

export const roomJoinSchema = z.object({
  // รหัสห้อง 6 ตัว ไม่ใช้ `0 O 1 I` (game-rules.md ข้อ 9) — รับตัวพิมพ์เล็กแล้วแปลงให้
  roomCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NP-Z2-9]{6}$/, 'รหัสห้องต้องเป็นตัวอักษรและตัวเลข 6 หลัก'),
  as: z.enum(['player', 'spectator']).default('player'),
});

export const roomRejoinSchema = z.object({
  roomId: z.number().int().positive(),
});

export const roomReadySchema = z.object({
  ready: z.boolean(),
});

export const solveMoveSchema = z.object({
  seq: z.number().int().positive(),
  // notation ตัวเดียวเท่านั้น — ห้ามส่งหลาย move รวมใน string เดียว (socket-events.md ข้อ 7)
  move: z.string().trim().min(1).max(4),
  clientTs: z.number().int().nonnegative(),
});

export const solveSolvedSchema = z.object({
  seq: z.number().int().nonnegative(),
  moveCount: z.number().int().nonnegative(),
  clientTs: z.number().int().nonnegative(),
});
