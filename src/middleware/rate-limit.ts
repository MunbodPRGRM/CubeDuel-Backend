import rateLimit, { type Options } from 'express-rate-limit';
import { errors } from '../lib/errors.js';
import { loginErrorUrl } from '../lib/oauth.js';
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

/**
 * ขอลิงก์รีเซ็ตรหัสผ่าน 10 ครั้ง / ชั่วโมง ต่อ IP — ชั้นนอกกันยิงไล่อีเมลทีละมาก ๆ
 * ส่วนเพดาน 3 ครั้งต่ออีเมลอยู่ใน `password-reset.service.ts` เพราะเกินแล้วต้องเงียบ ไม่ใช่ 429 (ADR-057 ข้อ 2)
 */
export const forgotPasswordLimiter = make({ windowMs: 60 * 60_000, limit: 10 });

/**
 * เข้าสู่ระบบด้วย Google 30 ครั้ง / 15 นาที ต่อ IP — นับรวมขาไปกับขากลับ (ล็อกอินหนึ่งรอบ = 2 ครั้ง)
 * สอง endpoint นี้เป็นการ **เปิดหน้าเว็บ** → เกินเพดานแล้วต้องพากลับหน้าเข้าสู่ระบบพร้อมข้อความ
 * ไม่ใช่ตอบ JSON 429 ให้ผู้ใช้เห็นข้อความดิบ (ADR-058 ข้อ 3)
 */
export const oauthLimiter = make({
  windowMs: 15 * 60_000,
  limit: 30,
  handler: (_req, res) => res.redirect(302, loginErrorUrl(env.frontendUrl, 'rate_limited')),
});

/** endpoint auth อื่น ๆ (refresh / logout / change-password / ลบบัญชี / reset-password) */
export const authLimiter = make({ windowMs: 15 * 60_000, limit: 60 });

/** แจ้งรายงานผู้เล่น 10 ครั้ง / ชั่วโมง ต่อ IP — กันสแปมจนหน้าแอดมินใช้งานไม่ได้ (api-contract.md ข้อ 8) */
export const reportLimiter = make({ windowMs: 60 * 60_000, limit: 10 });
