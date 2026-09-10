import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import type { UpdateProfileInput } from '../schemas/user.schema.js';
import { toPublicUser, toSelfUser, type PublicUserDto, type SelfUserDto } from '../types/api.js';

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

/**
 * แก้โปรไฟล์ของตัวเอง (api-contract.md ข้อ 3)
 *
 * รับเฉพาะ `nickname` กับ `cubeSkin` — `username`/`email` แก้ไม่ได้ (ADR-048 ข้อ 1)
 * `nickname` ที่ไม่ได้ส่งมา ≠ `nickname: null` (ไม่แตะ vs ล้างทิ้ง) จึงต้องดูว่าคีย์มีอยู่จริงไหม
 */
export async function updateOwnProfile(
  userId: number,
  input: UpdateProfileInput,
): Promise<SelfUserDto> {
  const data: Prisma.UserUpdateInput = {};
  if ('nickname' in input) data.nickname = input.nickname ?? null;
  if (input.cubeSkin !== undefined) data.cubeSkin = input.cubeSkin;

  const updated = await prisma.user.update({ where: { userId }, data });
  return toSelfUser(updated);
}
