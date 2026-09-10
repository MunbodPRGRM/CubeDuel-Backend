import { z } from 'zod';
import { CUBE_TYPES } from '../types/cube.js';

/** กฎ validation ของ endpoint กลุ่มแอดมิน (docs/api-contract.md ข้อ 9) */

export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'suspended', 'deleted', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateUserStatusSchema = z
  .object({
    status: z.enum(['active', 'suspended'], { required_error: 'ต้องระบุสถานะ' }),
    /** `null`/ไม่ส่ง + `suspended` = ระงับถาวร (database-schema.md ตารางที่ 1) */
    suspendedUntil: z.coerce.date().nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((v) => v.status === 'suspended' || !v.suspendedUntil, {
    message: 'ตั้งวันสิ้นสุดการระงับได้เฉพาะตอนสั่งระงับบัญชี',
    path: ['suspendedUntil'],
  });

/** เพดาน 0–4000 ตาม api-contract.md ข้อ 9 — กันแอดมินพิมพ์พลาดจนคะแนนเพี้ยนทั้งกระดาน */
export const updateUserRatingSchema = z.object({
  cubeType: z.enum(CUBE_TYPES, {
    required_error: 'ต้องระบุประเภทรูบิค',
    invalid_type_error: 'ประเภทรูบิคไม่ถูกต้อง',
  }),
  eloRating: z
    .number({ required_error: 'ต้องระบุคะแนนใหม่' })
    .int('คะแนนต้องเป็นจำนวนเต็ม')
    .min(0, 'คะแนนต้องอยู่ระหว่าง 0–4000')
    .max(4000, 'คะแนนต้องอยู่ระหว่าง 0–4000'),
  note: z.string().trim().max(500).nullish(),
});

export const flaggedQuerySchema = z.object({
  verdict: z.enum(['pending', 'clean', 'cheating', 'inconclusive', 'all']).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const reviewFlagSchema = z.object({
  verdict: z.enum(['clean', 'cheating', 'inconclusive'], {
    required_error: 'ต้องระบุผลการตรวจสอบ',
    invalid_type_error: 'ผลการตรวจสอบไม่ถูกต้อง',
  }),
  note: z.string().trim().max(500).nullish(),
});

export const flagIdParamSchema = z.coerce.number().int().positive();

export type AdminUsersQueryInput = z.infer<typeof adminUsersQuerySchema>;
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;
export type UpdateUserRatingInput = z.infer<typeof updateUserRatingSchema>;
export type FlaggedQueryInput = z.infer<typeof flaggedQuerySchema>;
export type ReviewFlagInput = z.infer<typeof reviewFlagSchema>;
