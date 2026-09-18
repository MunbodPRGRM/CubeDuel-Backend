import { UserStatus, type Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import type { OnlineUsersQueryInput, UpdateProfileInput } from '../schemas/user.schema.js';
import { ACTIVITY_ORDER, activityOf } from '../sockets/activity.js';
import { onlineUserIds } from '../sockets/presence.js';
import {
  toPublicUser,
  toSelfUser,
  type OnlineUserDto,
  type OnlineUsersDto,
  type PublicUserDto,
  type SelfUserDto,
} from '../types/api.js';

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

/**
 * สมาชิกที่ออนไลน์อยู่ตอนนี้ + กิจกรรม (api-contract.md ข้อ 3 · ADR-086 ข้อ 3)
 *
 * ใครออนไลน์ + ทำอะไรอยู่ มาจาก memory ของ Socket.IO · **ชื่อมาจาก DB** — ชื่อเล่นที่แก้หลังต่อ socket
 * จะได้ไม่ค้าง และคัดบัญชีที่ถูกระงับ/ลบไปแล้วทิ้งได้ในคำสั่งเดียว
 * จำนวนคนออนไลน์มีแค่ระดับร้อย (instance เดียว — ADR-034) `id in (...)` ครั้งเดียวจึงพอ ไม่ต้องแบ่งหน้า
 */
export async function listOnlineUsers(query: OnlineUsersQueryInput): Promise<OnlineUsersDto> {
  const ids = [...onlineUserIds()];
  if (ids.length === 0) return { online: 0, total: 0, users: [] };

  const rows = await prisma.user.findMany({
    where: {
      userId: { in: ids },
      deletedAt: null,
      status: UserStatus.ACTIVE,
      ...(query.q
        ? {
            OR: [
              { username: { contains: query.q, mode: 'insensitive' } },
              { nickname: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: { userId: true, username: true, nickname: true },
  });

  const users: OnlineUserDto[] = rows
    .map((row) => ({ ...row, ...activityOf(row.userId) }))
    .sort(
      (a, b) =>
        ACTIVITY_ORDER.indexOf(a.activity) - ACTIVITY_ORDER.indexOf(b.activity) ||
        (a.nickname ?? a.username).localeCompare(b.nickname ?? b.username, 'th'),
    );

  return { online: ids.length, total: users.length, users: users.slice(0, query.limit) };
}
