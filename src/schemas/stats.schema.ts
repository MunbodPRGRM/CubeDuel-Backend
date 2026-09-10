import { z } from 'zod';
import { CUBE_TYPES } from '../types/cube.js';

/** กฎมาจาก docs/api-contract.md ข้อ 4 — สถิติเป็นของ "ประเภทรูบิคหนึ่งประเภท" เสมอ */
export const userStatsQuerySchema = z.object({
  cubeType: z.enum(CUBE_TYPES, {
    required_error: 'ต้องระบุ cubeType',
    invalid_type_error: 'cubeType ไม่ถูกต้อง',
  }),
});

export type UserStatsQueryInput = z.infer<typeof userStatsQuerySchema>;

/**
 * กฎมาจาก docs/api-contract.md ข้อ 3 — ตัวกรองทุกตัวไม่บังคับ (ไม่ใส่ = เอาทุกอย่าง)
 * `roomType` แปลว่า "ห้องที่ปรับคะแนน / ไม่ปรับคะแนน" ครอบทั้งสองระบบแมตช์ (ADR-045 ข้อ 4)
 */
export const matchHistoryQuerySchema = z.object({
  cubeType: z.enum(CUBE_TYPES, { invalid_type_error: 'cubeType ไม่ถูกต้อง' }).optional(),
  roomType: z.enum(['competitive', 'custom']).optional(),
  kind: z.enum(['1v1', 'multiplayer']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type MatchHistoryQueryInput = z.infer<typeof matchHistoryQuerySchema>;
