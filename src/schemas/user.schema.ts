import { z } from 'zod';
import { CUBE_SKINS } from '../constants.js';

/** ADR-066 ข้อ 1 — ต้องไม่เกินความกว้างคอลัมน์ `VARCHAR(300)` ใน DB */
export const BIO_MAX_LENGTH = 300;
/** ADR-066 ข้อ 4 — กันคนดันการ์ดโปรไฟล์ยาวเป็นจอด้วย `\n` ล้วน */
export const BIO_MAX_LINES = 6;

/**
 * อักขระที่มองไม่เห็นแต่พลิกทิศ/ซ่อนข้อความได้ — zero-width + bidi override (ADR-066 ข้อ 4)
 * ปล่อยให้ผ่านไปแล้วหน้าโปรไฟล์ของคนอื่นอ่านไม่ออกได้จริง ไม่ใช่แค่เรื่องความสวยงาม
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * ทำความสะอาด `bio` ก่อนนับความยาว (ADR-066 ข้อ 4)
 *
 * ทำที่นี่ที่เดียว — ถ้ากระจายไปทำที่ service ด้วย จะมีวันที่สองที่ไม่ตรงกัน
 */
export function normalizeBio(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n') // Windows/Mac เก่าส่งมาไม่เหมือนกัน ไม่แปลงแล้วนับตัวอักษรเกินจริง
    .replace(INVISIBLE_CHARS, '')
    .replace(/[ \t]+$/gm, '') // ช่องว่างท้ายบรรทัดไม่มีความหมาย แต่กินโควตา
    .replace(/\n{3,}/g, '\n\n') // บรรทัดว่างติดกันเหลือหนึ่ง
    .trim();
}

/** ใช้ซ้ำกับ `bio` ทุกที่ที่รับค่าจากผู้ใช้ — ว่างล้วนหลัง normalize = `null` (ล้างทิ้ง) */
const bioField = z
  .string()
  .transform(normalizeBio)
  .refine((v) => v.length <= BIO_MAX_LENGTH, `ข้อความแนะนำตัวต้องยาวไม่เกิน ${BIO_MAX_LENGTH} ตัวอักษร`)
  .refine(
    (v) => v.split('\n').length <= BIO_MAX_LINES,
    `ข้อความแนะนำตัวต้องไม่เกิน ${BIO_MAX_LINES} บรรทัด`,
  )
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional();

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
    /** เก็บเป็นข้อความล้วน — ฝั่งแสดงผลห้าม render เป็น HTML และไม่ทำ auto-link (ADR-066 ข้อ 3) */
    bio: bioField,
    cubeSkin: z.enum(CUBE_SKINS, { errorMap: () => ({ message: 'ไม่รู้จักสกินนี้' }) }).optional(),
  })
  .strict('ส่งฟิลด์ที่แก้ไม่ได้มาด้วย (แก้ได้เฉพาะ nickname, bio กับ cubeSkin)')
  .refine((v) => Object.keys(v).length > 0, 'ไม่มีอะไรให้แก้');

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
