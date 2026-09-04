import type { RequestHandler } from 'express';
import { UserRole, type User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { assertUsable } from '../services/auth.service.js';

/**
 * ตรวจ access token → ใส่ผู้ใช้ลง req.user
 *
 * ADR-013 บอกว่า access token ตรวจแบบ stateless (ไม่แตะตาราง RefreshToken)
 * แต่ยังต้องอ่านแถว User หนึ่งครั้งต่อ request เพราะแอดมินระงับบัญชีแล้วต้องมีผลทันที
 * ถ้าไม่อ่าน คนถูกระงับจะเล่นต่อได้อีก 15 นาทีจนกว่า access token จะหมดอายุ (ADR-023)
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return next(errors.unauthenticated('ต้องแนบ access token มาด้วย (Authorization: Bearer ...)'));
  }

  const payload = verifyAccessToken(token);

  prisma.user
    .findUnique({ where: { userId: payload.sub } })
    .then(async (user) => {
      if (!user) throw errors.unauthenticated('ไม่พบบัญชีผู้ใช้');
      req.user = await assertUsable(user);
      next();
    })
    .catch(next);
};

/** ต้องใช้ต่อจาก requireAuth เสมอ */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(errors.unauthenticated());
  if (req.user.role !== UserRole.ADMIN) {
    return next(errors.forbidden('ต้องเป็นผู้ดูแลระบบเท่านั้น'));
  }
  next();
};

/** ใช้ในตัว handler ที่รู้ว่าผ่าน requireAuth มาแล้ว — กัน non-null assertion กระจายทั่วโค้ด */
export function currentUser(req: { user?: User }): User {
  if (!req.user) throw errors.unauthenticated();
  return req.user;
}
