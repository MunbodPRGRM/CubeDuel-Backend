import rateLimit, { type Options } from 'express-rate-limit';
import { errors } from '../lib/errors.js';
import { env } from '../config/env.js';

/**
 * Rate limit ของ endpoint กลุ่ม auth (api-contract.md ข้อ 2 + ข้อ 11)
 *
 * เก็บตัวนับใน memory ของ process เดียว — พอสำหรับโปรเจกต์นี้ที่รัน server ตัวเดียว
 * ถ้าวันหนึ่งขยายเป็นหลาย instance ต้องเปลี่ยนไปใช้ store กลาง (Redis) ไม่งั้นเพดานจะคูณตามจำนวน instance
 */
function make(overrides: Partial<Options>) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // ตอน dev ยิงทดสอบรัว ๆ ได้ ไม่งั้นเทสเองก็โดนบล็อก
    skip: () => !env.isProduction && process.env.DISABLE_RATE_LIMIT === 'true',
    handler: (_req, _res, next) => next(errors.rateLimited()),
    ...overrides,
  });
}

/** 10 ครั้ง / 15 นาที ต่อ IP — กัน brute force รหัสผ่าน */
export const loginLimiter = make({ windowMs: 15 * 60_000, limit: 10 });

/** สมัครสมาชิก 5 ครั้ง / ชั่วโมง ต่อ IP — กันสร้างบัญชีรัว */
export const registerLimiter = make({ windowMs: 60 * 60_000, limit: 5 });

/** endpoint auth อื่น ๆ (refresh / logout / change-password / ลบบัญชี) */
export const authLimiter = make({ windowMs: 15 * 60_000, limit: 60 });

/** แจ้งรายงานผู้เล่น 10 ครั้ง / ชั่วโมง ต่อ IP — กันสแปมจนหน้าแอดมินใช้งานไม่ได้ (api-contract.md ข้อ 8) */
export const reportLimiter = make({ windowMs: 60 * 60_000, limit: 10 });
