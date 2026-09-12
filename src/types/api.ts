/**
 * ชนิดข้อมูลที่ "ส่งออกทาง API" — camelCase + ค่า enum ตัวพิมพ์เล็ก ตาม docs/api-contract.md
 * DB เป็น snake_case + enum ตัวพิมพ์ใหญ่ → แปลงที่ชั้นนี้ที่เดียวเท่านั้น (api-contract.md ข้อ 11)
 */
import type { User, UserRole, UserStatus } from '@prisma/client';

export type ApiUserRole = 'member' | 'admin';
export type ApiUserStatus = 'active' | 'suspended';

export const USER_ROLE_TO_API: Record<UserRole, ApiUserRole> = {
  MEMBER: 'member',
  ADMIN: 'admin',
};

export const USER_STATUS_TO_API: Record<UserStatus, ApiUserStatus> = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
};

/** โปรไฟล์สาธารณะ — ห้ามมี email (api-contract.md ข้อ 11) */
export interface PublicUserDto {
  userId: number;
  username: string;
  nickname: string | null;
  /**
   * ข้อความแนะนำตัว — **ข้อความล้วน** ฝั่งแสดงผลห้าม render เป็น HTML และไม่ทำ auto-link (ADR-066 ข้อ 3)
   * บัญชีที่ถูกระงับต้องได้ `null` ตรงนี้ — คุมที่ `getPublicProfile()` ไม่ใช่ที่ตัวแปลงนี้ (ADR-066 ข้อ 6)
   */
  bio: string | null;
  role: ApiUserRole;
  createdAt: string;
}

/** ข้อมูลของเจ้าของบัญชีเอง — มี email ได้ */
export interface SelfUserDto extends PublicUserDto {
  email: string;
  cubeSkin: string;
  status: ApiUserStatus;
  /**
   * `false` = บัญชี Google ที่ยังไม่เคยตั้งรหัสผ่าน (ADR-058 ข้อ 6)
   * หน้าตั้งค่าใช้ตัดสินว่าต้องถามรหัสผ่านเดิม/รหัสผ่านยืนยันไหม — เป็น boolean ไม่มีอะไรของ hash หลุด
   */
  hasPassword: boolean;
}

export function toPublicUser(user: User): PublicUserDto {
  return {
    userId: user.userId,
    username: user.username,
    nickname: user.nickname,
    bio: user.bio,
    role: USER_ROLE_TO_API[user.role],
    createdAt: user.createdAt.toISOString(),
  };
}

export function toSelfUser(user: User): SelfUserDto {
  return {
    ...toPublicUser(user),
    email: user.email,
    cubeSkin: user.cubeSkin,
    status: USER_STATUS_TO_API[user.status],
    hasPassword: user.passwordHash !== null,
  };
}

/** ผลลัพธ์ของทุก endpoint ที่ออก token ให้ (register / login / refresh) */
export interface AuthSessionDto {
  user: SelfUserDto;
  accessToken: string;
  refreshToken: string;
}
