import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { sendMail, type MailMessage } from '../lib/mailer.js';
import { hashPassword } from '../lib/password.js';
import { generateOpaqueToken, hashToken } from '../lib/tokens.js';
import { env } from '../config/env.js';
import { PASSWORD_RESET_MAX_PER_HOUR, PASSWORD_RESET_TTL_MS } from '../constants.js';
import { revokeAllRefreshTokens } from './auth.service.js';

/**
 * ลืมรหัสผ่าน / รีเซ็ตรหัสผ่าน — ที่มาของกฎ: docs/database-schema.md ตารางที่ 3,
 * docs/api-contract.md ข้อ 2, ADR-057
 *
 * กฎที่ห้ามพลาด:
 *   - DB เก็บแค่ SHA-256 ของ token · token ดิบอยู่ในอีเมลที่เดียว
 *   - คนนอกต้องแยกไม่ออกว่าอีเมลไหนมีบัญชี — ทั้งจาก response และจากสิ่งที่ผิดพลาด
 *   - รีเซ็ตสำเร็จ = เพิกถอน refresh token ทั้งหมด (ADR-013)
 */

const HOUR_MS = 60 * 60_000;

/** ข้อความเดียวกันทุกกรณีที่ token ใช้ไม่ได้ — ไม่บอกคนนอกว่าติดเพราะอะไร (ADR-057 ข้อ 5) */
const INVALID_TOKEN = 'ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว กรุณาขอลิงก์ใหม่';

function invalidToken() {
  return errors.validation(INVALID_TOKEN, { token: INVALID_TOKEN });
}

// ---------------------------------------------------------------- ขอลิงก์

/**
 * ถูกเรียก **หลัง** ตอบ 200 ไปแล้ว (ADR-057 ข้อ 1) — ทุกทางที่ไม่ส่งอีเมลจึงแค่ `return` เงียบ ๆ
 * ไม่มีใครรอฟังผลของฟังก์ชันนี้นอกจาก log
 */
export async function requestPasswordReset(email: string): Promise<void> {
  // บัญชีที่ถูกลบหาไม่เจออยู่แล้วเพราะอีเมลถูกแทนเป็น deleted_{id}@… (ADR-008) — ใส่ไว้ให้ชัด
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { userId: true, username: true },
  });
  if (!user) return;

  // เพดานต่ออีเมลนับจากแถวใน DB — แถวที่ถูกปิดเพราะขอใหม่ก็นับ จึงห้ามลบแถวทิ้ง (ADR-057 ข้อ 2–3)
  const recent = await prisma.passwordResetToken.count({
    where: { userId: user.userId, createdAt: { gt: new Date(Date.now() - HOUR_MS) } },
  });
  if (recent >= PASSWORD_RESET_MAX_PER_HOUR) return;

  const token = generateOpaqueToken();
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // ขอใหม่ = ลิงก์เก่าที่ยังไม่ได้ใช้เป็นโมฆะ · schema ไม่มี revoked_at จึงปิดด้วย used_at (ADR-057 ข้อ 3)
    await tx.passwordResetToken.updateMany({
      where: { userId: user.userId, usedAt: null },
      data: { usedAt: now },
    });
    await tx.passwordResetToken.create({
      data: {
        userId: user.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      },
    });
  });

  await sendMail(resetEmail(email, user.username, token));
}

function resetLink(token: string): string {
  return `${env.frontendUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function resetEmail(to: string, username: string, token: string): MailMessage {
  const link = resetLink(token);
  const minutes = PASSWORD_RESET_TTL_MS / 60_000;
  const name = escapeHtml(username);

  return {
    to,
    subject: 'ตั้งรหัสผ่านใหม่ — CubeDuel',
    text: [
      `สวัสดี ${username}`,
      '',
      'มีคำขอตั้งรหัสผ่านใหม่ของบัญชี CubeDuel ที่ใช้อีเมลนี้',
      `กดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่ (ใช้ได้ภายใน ${minutes} นาที และใช้ได้ครั้งเดียว):`,
      '',
      link,
      '',
      'ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ',
    ].join('\n'),
    html: `<p>สวัสดี <strong>${name}</strong></p>
<p>มีคำขอตั้งรหัสผ่านใหม่ของบัญชี CubeDuel ที่ใช้อีเมลนี้<br>
กดปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่ — ใช้ได้ภายใน ${minutes} นาที และใช้ได้ครั้งเดียว</p>
<p><a href="${link}" style="display:inline-block;padding:10px 20px;border-radius:8px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600">ตั้งรหัสผ่านใหม่</a></p>
<p style="color:#64748b;font-size:13px">ถ้ากดปุ่มไม่ได้ ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์:<br>${link}</p>
<p style="color:#64748b;font-size:13px">ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ</p>`,
  };
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
