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
  /** คิวห้องผู้เล่นหลายคนเป็นงานเฟส 6 — ปฏิเสธตั้งแต่ชั้น schema (ADR-039 ข้อ 9) */
  kind: z
    .enum(['competitive', 'multiplayer'])
    .default('competitive')
    .refine((kind) => kind !== 'multiplayer', {
      message: 'คิวห้องผู้เล่นหลายคนยังไม่เปิด (เฟส 6)',
    }),
});

/**
 * `room:create` — จำนวนผู้เล่นที่รับได้ขึ้นกับชนิดห้อง จึงต้องตรวจสองฟิลด์คู่กัน
 *
 * `custom` = ห้องสร้างเอง 1v1 · เปิดใช้จริงแล้ว
 * `competitive` / `multiplayer` = สร้างเองได้เฉพาะตอนเปิดสวิตช์ทดสอบ
 * `ALLOW_TEST_COMPETITIVE_ROOM=1` บนเครื่อง dev (ADR-038) — production ปิดตาย
 * ห้องหลายคนเปิดให้ผู้ใช้จริงในเฟส 6 ก้อนที่ 2 พร้อมคิวและกติกาคนไม่ครบ (ADR-041 ข้อ 3)
 * ตอนนี้เปิดแค่พอให้ `npm run smoke:multi` บังคับสร้างห้อง 3–4 คนมาทดสอบการบันทึกผลได้
 */
export const roomCreateSchema = z
  .object({
    cubeType: z.enum(CUBE_TYPES),
    kind: z.enum(['custom', 'multiplayer', 'competitive']),
    maxPlayers: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    /**
     * **เฉพาะสวิตช์ทดสอบ** — ห้องหลายคนที่สร้างด้วยรหัสคือโหมด `custom` เสมอ โหมด `auto`
     * มาจากคิวจับคู่เท่านั้น (เฟส 6 ก้อนที่ 2) แต่ `npm run smoke:multi` ต้องทดสอบทาง
     * ที่ปรับ Pairwise Elo จริงก่อนคิวจะเสร็จ จึงเปิดให้ระบุเองได้บนเครื่อง dev
     * เหตุผลเดียวกับ `ALLOW_TEST_COMPETITIVE_ROOM` ของห้องแข่งขัน 1v1 (ADR-038 ข้อ 5)
     */
    roomMode: z.enum(['auto', 'custom']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'custom' && !env.allowTestCompetitiveRoom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'ตอนนี้เปิดใช้เฉพาะห้องสร้างเอง 1v1 (ห้องผู้เล่นหลายคนยังไม่เปิด)',
      });
      return;
    }
    if (value.roomMode !== undefined && !(value.kind === 'multiplayer' && env.allowTestCompetitiveRoom)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roomMode'],
        message: 'ระบุ roomMode เองไม่ได้ (โหมด auto มาจากคิวจับคู่เท่านั้น)',
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

export const solveSolvedSchema = z.object({
  seq: z.number().int().nonnegative(),
  moveCount: z.number().int().nonnegative(),
  clientTs: z.number().int().nonnegative(),
});
