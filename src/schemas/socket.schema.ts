/**
 * ตรวจ payload ของทุก event ก่อนเข้า handler — ผิดรูปตอบ `E_VALIDATION`
 * รูป payload ต้องตรงกับ `docs/socket-events.md` (แก้เอกสารก่อนเสมอ)
 */
import { z } from 'zod';
import { env } from '../config/env.js';
import { CUBE_TYPES } from '../types/cube.js';

/** payload ที่ไม่มีฟิลด์อะไรเลย — client บางตัวส่ง `undefined` มา จึงใส่ค่าเริ่มต้นให้ */
export const emptyPayloadSchema = z.object({}).default({});

export const netPingSchema = z.object({
  clientTs: z.number().int().nonnegative(),
  /** RTT ที่ client วัดได้จากการ ping ครั้งก่อน — ครั้งแรกยังไม่มี */
  lastRttMs: z.number().int().nonnegative().optional(),
});

export const queueJoinSchema = z.object({
  cubeType: z.enum(CUBE_TYPES),
  /** `competitive` = 1v1 · `multiplayer` = 3–4 คน — คนละช่องคิวกัน (game-rules.md ข้อ 8) */
  kind: z.enum(['competitive', 'multiplayer']).default('competitive'),
});

/**
 * `room:create` — จำนวนผู้เล่นที่รับได้ขึ้นกับชนิดห้อง จึงต้องตรวจสองฟิลด์คู่กัน
 *
 * `custom` = ห้องสร้างเอง 1v1 (2 คน) · `multiplayer` = ห้องสร้างเอง 3–4 คน — เปิดใช้จริงทั้งคู่
 * ห้องที่สร้างด้วยรหัสเป็น **โหมด `custom` เสมอ** (ไม่ปรับคะแนน) โหมด `auto` ที่ปรับ Pairwise Elo
 * มาจากคิวจับคู่เท่านั้น จึงไม่มีฟิลด์ `roomMode` ให้ client ส่งมาแล้ว (ADR-043 ข้อ 5)
 *
 * `competitive` สร้างเองไม่ได้ — ห้องแข่งขัน 1v1 เกิดจากคิวเท่านั้น เปิดได้เฉพาะเครื่อง dev
 * ที่ตั้ง `ALLOW_TEST_COMPETITIVE_ROOM=1` ไว้ใช้กับ `npm run smoke:rated` (ADR-038 ข้อ 5)
 */
export const roomCreateSchema = z
  .object({
    cubeType: z.enum(CUBE_TYPES),
    kind: z.enum(['custom', 'multiplayer', 'competitive']),
    maxPlayers: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'competitive' && !env.allowTestCompetitiveRoom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'ห้องแข่งขันเกิดจากคิวจับคู่เท่านั้น สร้างเองไม่ได้',
      });
      return;
    }
    const allowed = value.kind === 'multiplayer' ? [3, 4] : [2];
    if (!allowed.includes(value.maxPlayers)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxPlayers'],
        message:
          value.kind === 'multiplayer'
            ? 'ห้องผู้เล่นหลายคนรองรับ 3 หรือ 4 คนเท่านั้น'
            : 'ห้อง 1v1 รองรับ 2 คนเท่านั้น',
      });
    }
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

/** หนึ่งช่องของ quaternion หนึ่งหน่วย — อยู่ใน [-1, 1] เสมอ */
const quaternionPart = z.number().finite().min(-1).max(1);

/**
 * `solve:camera` (ADR-062) — server แค่ส่งต่อ แต่ต้องกันค่าที่ทำให้ฝั่งรับพัง (ระยะล้าน · เวกเตอร์ศูนย์)
 * client ปัดทศนิยม 4 ตำแหน่ง ความยาวจึงคลาดจาก 1 ได้นิดหน่อย
 */
export const solveCameraSchema = z.object({
  q: z
    .tuple([quaternionPart, quaternionPart, quaternionPart, quaternionPart])
    .refine((q) => Math.abs(Math.hypot(...q) - 1) < 0.01, 'quaternion ต้องยาว 1 หน่วย'),
  d: z.number().finite().min(1).max(50),
});

export const solveSolvedSchema = z.object({
  seq: z.number().int().nonnegative(),
  moveCount: z.number().int().nonnegative(),
  clientTs: z.number().int().nonnegative(),
});
