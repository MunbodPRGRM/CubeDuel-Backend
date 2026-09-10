import { z } from 'zod';
import { CUBE_SKINS } from '../constants.js';

/**
 * กฎ validation ของ `PATCH /users/me` (api-contract.md ข้อ 3)
 *
 * `username` กับ `email` **ไม่อยู่ในนี้โดยตั้งใจ** — แก้ไม่ได้ทาง endpoint นี้ (ADR-048 ข้อ 1)
 */
export const updateProfileSchema = z
  .object({
    /**
     * `null` = ล้างชื่อเล่นทิ้ง · ไม่ส่งมาเลย = ไม่แตะ
     * ต้องแยกสองกรณีนี้ให้ออก จึงใช้ `.nullable().optional()` ไม่ใช่ `.nullish()` เฉย ๆ
     * แล้วเช็คด้วย `'nickname' in body` ที่ชั้น service
     */
    nickname: z
      .string()
      .trim()
      .max(50, 'ชื่อเล่นต้องยาว 1–50 ตัวอักษร')
      // ช่องว่างล้วนถือว่า "ล้างทิ้ง" — ผู้ใช้ลบข้อความในช่องแล้วกดบันทึกคือเจตนานี้
      .transform((v) => (v.length === 0 ? null : v))
      .nullable()
      .optional(),
    cubeSkin: z.enum(CUBE_SKINS, { errorMap: () => ({ message: 'ไม่รู้จักสกินนี้' }) }).optional(),
  })
  .strict('ส่งฟิลด์ที่แก้ไม่ได้มาด้วย (แก้ได้เฉพาะ nickname กับ cubeSkin)')
  .refine((v) => Object.keys(v).length > 0, 'ไม่มีอะไรให้แก้');

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
