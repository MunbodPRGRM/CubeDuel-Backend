import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { errors } from './errors.js';
import type { ApiUserRole } from '../types/api.js';

/** payload ของ access token ตาม api-contract.md ข้อ 2 */
export interface AccessTokenPayload {
  sub: number;
  username: string;
  role: ApiUserRole;
}

/** payload ของ refresh token — jti ไม่ได้ใช้เป็นตัวชี้แถว (แถวหาเจอจาก hash ของ token) แต่กันไม่ให้ token ซ้ำกัน */
export interface RefreshTokenPayload {
  sub: number;
  jti: string;
}

/** แปลง '15m' / '30d' / '3600' เป็นมิลลิวินาที — ใช้คำนวณ expires_at ให้ตรงกับอายุของ JWT */
export function parseDurationMs(value: string): number {
  const m = /^(\d+)([smhd])?$/.exec(value.trim());
  if (!m) throw new Error(`รูปแบบอายุ token ไม่ถูกต้อง: ${value}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const factor = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1_000;
  return n * factor;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires as jwt.SignOptions['expiresIn'],
  });
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpires as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret) as jwt.JwtPayload;
    return { sub: Number(decoded.sub), username: decoded.username, role: decoded.role };
  } catch {
    // ไม่แยกว่า "หมดอายุ" หรือ "ปลอม" — ทั้งคู่ให้ผู้ใช้ทำอย่างเดียวกันคือขอ token ใหม่
    throw errors.unauthenticated('เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwt.refreshSecret) as jwt.JwtPayload;
    return { sub: Number(decoded.sub), jti: String(decoded.jti ?? '') };
  } catch {
    throw errors.unauthenticated('refresh token หมดอายุหรือไม่ถูกต้อง');
  }
}
