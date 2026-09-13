import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { generateOpaqueToken, hashToken } from '../lib/tokens.js';
import { env } from '../config/env.js';
import { PASSWORD_RESET_TTL_MS } from '../constants.js';
import { revokeAllRefreshTokens } from './auth.service.js';

/**
 * รีเซ็ตรหัสผ่าน — ที่มาของกฎ: docs/database-schema.md ตารางที่ 3,
 * docs/api-contract.md ข้อ 2, ADR-057 ข้อ 3–7, ADR-068
 *
 * ไม่มี "ลืมรหัสผ่าน" ให้ผู้ใช้ขอลิงก์เองแล้ว (ADR-068) — ลิงก์ออกได้ทางเดียวคือ `issuePasswordResetLink()`
 *
 * กฎที่ห้ามพลาด:
 *   - DB เก็บแค่ SHA-256 ของ token · token ดิบอยู่ในลิงก์ที่เดียว
 *   - รีเซ็ตสำเร็จ = เพิกถอน refresh token ทั้งหมด (ADR-013)
 */

/** ข้อความเดียวกันทุกกรณีที่ token ใช้ไม่ได้ — ไม่บอกคนนอกว่าติดเพราะอะไร (ADR-057 ข้อ 5) */
const INVALID_TOKEN = 'ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว กรุณาติดต่อผู้ดูแลระบบเพื่อขอลิงก์ใหม่';

function invalidToken() {
  return errors.validation(INVALID_TOKEN, { token: INVALID_TOKEN });
}

// ---------------------------------------------------------------- ออกลิงก์

/**
 * ออก token ใบใหม่ของบัญชีนี้แล้วคืนลิงก์ดิบ — ลิงก์นี้คือที่เดียวที่ token ดิบปรากฏ
 * ผู้เรียกต้องตรวจเองว่าบัญชีมีอยู่จริงและยังไม่ถูกลบ
 */
export async function issuePasswordResetLink(
  userId: number,
): Promise<{ link: string; expiresAt: Date }> {
  const token = generateOpaqueToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);

  await prisma.$transaction(async (tx) => {
    // ออกใบใหม่ = ลิงก์เก่าที่ยังไม่ได้ใช้เป็นโมฆะ · schema ไม่มี revoked_at จึงปิดด้วย used_at (ADR-057 ข้อ 3)
    await tx.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });
    await tx.passwordResetToken.create({
      data: { userId, tokenHash: hashToken(token), expiresAt },
    });
  });

  return { link: resetLink(token), expiresAt };
}

function resetLink(token: string): string {
  return `${env.frontendUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------- ใช้ลิงก์

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(token);
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { userId: true, user: { select: { deletedAt: true } } },
  });
  // token ที่ออกไว้ก่อนเจ้าของลบบัญชียังอยู่ในตาราง ต้องตรวจซ้ำตรงนี้ (ADR-057 ข้อ 4)
  if (!row || row.user.deletedAt) throw invalidToken();

  // bcrypt ช้า — ทำนอกทรานแซกชัน และทำหลังรู้แล้วว่า token มีอยู่จริง ไม่ให้ token มั่วเปลือง CPU
  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    // เขียนแบบมีเงื่อนไขแล้วนับแถว ไม่ใช่อ่านก่อนแล้วค่อยเขียน — กดลิงก์เดียวกันสองแท็บพร้อมกัน
    // ต้องผ่านได้ครั้งเดียว (ADR-057 ข้อ 5) · หมดอายุ/ใช้แล้วก็ตกที่นี่ด้วยข้อความเดียวกัน
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw invalidToken();

    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: now },
    });
    await tx.user.update({ where: { userId: row.userId }, data: { passwordHash } });
    // รีเซ็ตรหัสผ่านแล้วต้องเตะทุกอุปกรณ์ออก เหมือนเปลี่ยนรหัสผ่าน (ADR-013)
    await revokeAllRefreshTokens(row.userId, tx);
  });
}
