/**
 * Rate limit ระดับ socket — token bucket ต่อ **socket ต่อชื่อ event**
 *
 * ที่มา: `docs/socket-events.md` ข้อ 7 (`solve:move` 30 ครั้ง/วินาที) + checklist ข้อ 11
 * ใช้ `express-rate-limit` ไม่ได้เพราะมันผูกกับ req/res ของ HTTP และนับต่อ IP
 * เราต้องนับต่อ connection ไม่งั้นผู้เล่นหลายคนหลัง NAT เดียวกันจะกินโควตากันเอง (ADR-034 ข้อ 6)
 */
import { env } from '../config/env.js';

/** จำนวนครั้งต่อวินาทีของแต่ละ event — ไม่ระบุ = ใช้ค่าเริ่มต้น */
const LIMIT_PER_SECOND: Record<string, number> = {
  'solve:move': 30,
};
const DEFAULT_LIMIT_PER_SECOND = 20;

interface Bucket {
  /** โควตาที่เหลือ (ทศนิยมได้ เพราะเติมตามเวลาที่ผ่านไปจริง) */
  tokens: number;
  lastRefillTs: number;
}

/** ตัวนับของ socket หนึ่งตัว — ทิ้งทั้งก้อนตอน disconnect */
export class SocketRateLimiter {
  readonly #buckets = new Map<string, Bucket>();

  /** คืน `true` ถ้ายังส่งได้ · `false` = เกินโควตา ให้ตอบ `E_RATE_LIMITED` */
  allow(event: string, now = Date.now()): boolean {
    if (!env.isProduction && process.env.DISABLE_RATE_LIMIT === 'true') return true;

    const limit = LIMIT_PER_SECOND[event] ?? DEFAULT_LIMIT_PER_SECOND;
    const bucket = this.#buckets.get(event) ?? { tokens: limit, lastRefillTs: now };

    // เติมโควตาตามเวลาที่ผ่านไป (เต็มถังภายใน 1 วินาที) แล้วหักหนึ่งครั้ง
    const refill = ((now - bucket.lastRefillTs) / 1_000) * limit;
    bucket.tokens = Math.min(limit, bucket.tokens + refill);
    bucket.lastRefillTs = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.#buckets.set(event, bucket);
    return allowed;
  }

  clear(): void {
    this.#buckets.clear();
  }
}
