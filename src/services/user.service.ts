import { UserStatus, type Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import type { UpdateProfileInput } from '../schemas/user.schema.js';
import { toPublicUser, toSelfUser, type PublicUserDto, type SelfUserDto } from '../types/api.js';

/**
 * โปรไฟล์สาธารณะของผู้ใช้คนหนึ่ง (api-contract.md ข้อ 3)
 *
 * **ห้ามมี `email`** — `toPublicUser()` เป็นตัวคุมว่าออกไปแค่ช่องไหน (api-contract.md ข้อ 11)
 * บัญชีที่ลบตัวเองแล้วถือว่าไม่มีอยู่ เหมือนกับที่กระดานอันดับกรองออก (ADR-008)
 *
 * **บัญชีที่ถูกระงับคืน `bio: null`** โดยไม่ลบของจริงใน DB — ปลดระงับแล้วได้คืนเอง (ADR-066 ข้อ 6)
 * การระงับต้องหยุดข้อความที่คนอื่นเห็นด้วย ไม่ใช่หยุดแค่การเล่น
 */
export async function getPublicProfile(userId: number): Promise<PublicUserDto> {
  const user = await prisma.user.findFirst({ where: { userId, deletedAt: null } });
  if (!user) throw errors.notFound('ไม่พบผู้ใช้รายนี้');
  const dto = toPublicUser(user);
  return user.status === UserStatus.SUSPENDED ? { ...dto, bio: null } : dto;
}

/**
 * แก้โปรไฟล์ของตัวเอง (api-contract.md ข้อ 3)
 *
 * รับเฉพาะ `nickname` / `bio` / `cubeSkin` — `username`/`email` แก้ไม่ได้ (ADR-048 ข้อ 1)
 * `nickname` ที่ไม่ได้ส่งมา ≠ `nickname: null` (ไม่แตะ vs ล้างทิ้ง) จึงต้องดูว่าคีย์มีอยู่จริงไหม
 * — `bio` ใช้กฎเดียวกัน · ตัวข้อความถูก normalize มาตั้งแต่ zod แล้ว ที่นี่ไม่แตะอีก (ADR-066 ข้อ 4)
 */
export async function updateOwnProfile(
  userId: number,
  input: UpdateProfileInput,
): Promise<SelfUserDto> {
  const data: Prisma.UserUpdateInput = {};
  if ('nickname' in input) data.nickname = input.nickname ?? null;
  if ('bio' in input) data.bio = input.bio ?? null;
  if (input.cubeSkin !== undefined) data.cubeSkin = input.cubeSkin;

  const updated = await prisma.user.update({ where: { userId }, data });
  return toSelfUser(updated);
}
