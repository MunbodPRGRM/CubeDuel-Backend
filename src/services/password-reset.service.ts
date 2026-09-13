import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { revokeAllRefreshTokens } from './auth.service.js';

/**
 * รีเซ็ตรหัสผ่านด้วย username + อีเมล — ไม่มีลิงก์ ไม่มี token (ADR-069 · api-contract.md ข้อ 2)
 *
 * ⚠️ ยอมรับความเสี่ยงโดยรู้ตัว: คนที่รู้อีเมลของเหยื่อยึดบัญชีได้ (ADR-069 ข้อ 2)
 *
 * กฎที่ห้ามพลาด:
 *   - บัญชีแอดมินใช้ทางนี้ไม่ได้ และต้องได้ข้อความเดียวกับ "ไม่ตรง" — ไม่บอกคนนอกว่าใครเป็นแอดมิน
 *   - รีเซ็ตสำเร็จ = เพิกถอน refresh token ทั้งหมด (ADR-013)
 */

const NO_MATCH = 'ชื่อผู้ใช้กับอีเมลไม่ตรงกับบัญชีที่รีเซ็ตรหัสผ่านได้';

export async function resetPassword(
  username: string,
  email: string,
  newPassword: string,
): Promise<void> {
  // บัญชีที่ถูกลบหาไม่เจออยู่แล้วเพราะชื่อ/อีเมลถูกแทนเป็น deleted_… (ADR-008) — ใส่ไว้ให้ชัด
  const user = await prisma.user.findFirst({
    where: { username, email, deletedAt: null },
    select: { userId: true, role: true },
  });
  if (!user || user.role === UserRole.ADMIN) throw errors.validation(NO_MATCH);

  // bcrypt ช้า — ทำนอกทรานแซกชัน และทำหลังรู้แล้วว่าตรง ไม่ให้ข้อมูลมั่วเปลือง CPU
  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { userId: user.userId }, data: { passwordHash } });
    // รีเซ็ตรหัสผ่านแล้วต้องเตะทุกอุปกรณ์ออก เหมือนเปลี่ยนรหัสผ่าน (ADR-013)
    await revokeAllRefreshTokens(user.userId, tx);
  });
}
