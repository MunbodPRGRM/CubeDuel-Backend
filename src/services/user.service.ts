import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { toPublicUser, type PublicUserDto } from '../types/api.js';

/**
 * โปรไฟล์สาธารณะของผู้ใช้คนหนึ่ง (api-contract.md ข้อ 3)
 *
 * **ห้ามมี `email`** — `toPublicUser()` เป็นตัวคุมว่าออกไปแค่ช่องไหน (api-contract.md ข้อ 11)
 * บัญชีที่ลบตัวเองแล้วถือว่าไม่มีอยู่ เหมือนกับที่กระดานอันดับกรองออก (ADR-008)
 */
export async function getPublicProfile(userId: number): Promise<PublicUserDto> {
  const user = await prisma.user.findFirst({ where: { userId, deletedAt: null } });
  if (!user) throw errors.notFound('ไม่พบผู้ใช้รายนี้');
  return toPublicUser(user);
}
