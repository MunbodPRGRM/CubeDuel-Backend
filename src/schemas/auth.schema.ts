import { z } from 'zod';
import { PASSWORD_MAX_BYTES } from '../constants.js';

/**
 * กฎ validation ทั้งหมดมาจาก docs/api-contract.md ข้อ 2
 * ห้ามเชื่อ client — ทุกกฎต้องตรวจซ้ำที่นี่แม้ frontend จะตรวจแล้ว
 */

/**
 * ชื่อ/อีเมลที่ระบบจองไว้ให้บัญชีที่ถูกลบ (ADR-008: username = deleted_user_{id})
 * ถ้าปล่อยให้สมัครชื่อนี้ได้ วันที่เจ้าของ id นั้นลบบัญชีจริงจะชน unique index แล้วพังเป็น 500
 */
const RESERVED_USERNAME_PREFIX = /^deleted_user_/i;
const RESERVED_EMAIL = /^deleted_\d+@cubeduel\.local$/i;

const username = z
  .string({ required_error: 'กรุณากรอกชื่อผู้ใช้' })
  .trim()
  .min(3, 'ชื่อผู้ใช้ต้องยาว 3–50 ตัวอักษร')
  .max(50, 'ชื่อผู้ใช้ต้องยาว 3–50 ตัวอักษร')
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'ใช้ได้เฉพาะ a-z A-Z 0-9 _ และห้ามขึ้นต้นด้วยตัวเลข')
  .refine((v) => !RESERVED_USERNAME_PREFIX.test(v), 'ชื่อผู้ใช้นี้ระบบสงวนไว้ กรุณาใช้ชื่ออื่น');

const email = z
  .string({ required_error: 'กรุณากรอกอีเมล' })
  .trim()
  .toLowerCase()
  .email('รูปแบบอีเมลไม่ถูกต้อง')
  .max(100, 'อีเมลต้องยาวไม่เกิน 100 ตัวอักษร')
  .refine((v) => !RESERVED_EMAIL.test(v), 'อีเมลนี้ระบบสงวนไว้ กรุณาใช้อีเมลอื่น');

const password = z
  .string({ required_error: 'กรุณากรอกรหัสผ่าน' })
  .min(8, 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร')
  .max(PASSWORD_MAX_BYTES, `รหัสผ่านต้องยาวไม่เกิน ${PASSWORD_MAX_BYTES} ตัวอักษร`)
  // bcrypt ตัดส่วนที่เกิน 72 ไบต์ทิ้งเงียบ ๆ — ภาษาไทย 1 ตัวกิน 3 ไบต์ จึงต้องนับไบต์ด้วย
  .refine(
    (v) => Buffer.byteLength(v, 'utf8') <= PASSWORD_MAX_BYTES,
    `รหัสผ่านยาวเกินไป (สูงสุด ${PASSWORD_MAX_BYTES} ไบต์)`,
  )
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข');

const nickname = z
  .string()
  .trim()
  .min(1, 'ชื่อเล่นต้องยาว 1–50 ตัวอักษร')
  .max(50, 'ชื่อเล่นต้องยาว 1–50 ตัวอักษร')
  .nullish();

export const registerSchema = z.object({
  username,
  email,
  password,
  nickname,
});

export const loginSchema = z.object({
  /** รับได้ทั้ง username และ email ในฟิลด์เดียว */
  identifier: z
    .string({ required_error: 'กรุณากรอกชื่อผู้ใช้หรืออีเมล' })
    .trim()
    .min(1, 'กรุณากรอกชื่อผู้ใช้หรืออีเมล'),
  password: z.string({ required_error: 'กรุณากรอกรหัสผ่าน' }).min(1, 'กรุณากรอกรหัสผ่าน'),
});

/** refresh/logout: token มาทาง httpOnly cookie (เว็บ) หรือ body (Capacitor) */
export const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1).optional(),
});

export const changePasswordSchema = z.object({
  /** ไม่บังคับสำหรับผู้ใช้ OAuth ที่ยังไม่เคยตั้งรหัสผ่าน (database-schema.md ตารางที่ 1) */
  currentPassword: z.string().min(1).optional(),
  newPassword: password,
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, 'กรุณากรอกรหัสผ่านเพื่อยืนยัน').optional(),
});

export const resetPasswordSchema = z.object({
  /** token ดิบจากลิงก์รีเซ็ต — ของจริงยาว 64 ตัว (48 ไบต์ base64url) เพดาน 200 กันยัดของยาว ๆ มาให้ hash */
  token: z
    .string({ required_error: 'ไม่พบรหัสในลิงก์รีเซ็ตรหัสผ่าน' })
    .trim()
    .min(1, 'ไม่พบรหัสในลิงก์รีเซ็ตรหัสผ่าน')
    .max(200, 'ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้อง'),
  newPassword: password,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
