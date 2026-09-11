import { Prisma, UserStatus, type User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { hashToken, newJti } from '../lib/tokens.js';
import {
  parseDurationMs,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt.js';
import { env } from '../config/env.js';
import { ALL_CUBE_TYPES, ELO_INITIAL_RATING } from '../constants.js';
import { toSelfUser, USER_ROLE_TO_API, type AuthSessionDto } from '../types/api.js';
import type { LoginInput, RegisterInput } from '../schemas/auth.schema.js';

/**
 * ระบบสมาชิกทั้งหมด — ที่มาของกฎ: docs/api-contract.md ข้อ 2, docs/database-schema.md ตารางที่ 1–4
 *
 * กฎที่ห้ามพลาด:
 *   - สมัครสมาชิก 1 คน = สร้างแถว Rating ครบ 4 cube_type ในทรานแซกชันเดียวกัน
 *   - password_hash เป็น NULL ได้ (ผู้ใช้ Google) → ตอน login ต้องบอกว่าใช้ Google
 *   - ลบบัญชีใช้ soft delete (ADR-008) ห้ามลบแถวจริง
 *   - เปลี่ยน/รีเซ็ตรหัสผ่าน ระงับบัญชี ลบบัญชี → เพิกถอน refresh token ทั้งหมด (ADR-013)
 */

/** ข้อความเดียวกันทั้งกรณี "ไม่มีผู้ใช้นี้" และ "รหัสผ่านผิด" — กันการไล่เดาว่าบัญชีไหนมีอยู่จริง */
const INVALID_CREDENTIALS = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';

// ---------------------------------------------------------------- session

/** ออก access + refresh token ให้ผู้ใช้ที่ผ่านการยืนยันตัวตนแล้ว (รหัสผ่าน หรือ Google — `oauth.service.ts`) */
export async function issueSession(user: User, deviceLabel?: string): Promise<AuthSessionDto> {
  const accessToken = signAccessToken({
    sub: user.userId,
    username: user.username,
    role: USER_ROLE_TO_API[user.role],
  });

  const refreshToken = signRefreshToken({ sub: user.userId, jti: newJti() });

  await prisma.refreshToken.create({
    data: {
      userId: user.userId,
      // DB เก็บแค่ SHA-256 ไม่เก็บ token ดิบ
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + parseDurationMs(env.jwt.refreshExpires)),
      deviceLabel: deviceLabel?.slice(0, 100) ?? null,
    },
  });

  return { user: toSelfUser(user), accessToken, refreshToken };
}

/** เพิกถอน refresh token ทั้งหมดที่ยังใช้ได้ของผู้ใช้คนหนึ่ง */
export async function revokeAllRefreshTokens(
  userId: number,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ---------------------------------------------------------------- สถานะบัญชี

/**
 * ตรวจว่าบัญชีใช้งานได้ไหม + ปลดระงับอัตโนมัติเมื่อครบกำหนด
 * (database-schema.md ตารางที่ 1: suspended_until มีค่า = ระงับชั่วคราว, NULL = ถาวร)
 */
export async function assertUsable(user: User): Promise<User> {
  if (user.deletedAt) throw errors.accountSuspended('บัญชีนี้ถูกลบไปแล้ว');

  if (user.status === UserStatus.SUSPENDED) {
    if (user.suspendedUntil && user.suspendedUntil <= new Date()) {
      return prisma.user.update({
        where: { userId: user.userId },
        data: { status: UserStatus.ACTIVE, suspendedUntil: null },
      });
    }
    throw errors.accountSuspended(
      user.suspendedUntil
        ? 'บัญชีนี้ถูกระงับชั่วคราว กรุณาลองใหม่ภายหลัง'
        : 'บัญชีนี้ถูกระงับการใช้งานถาวร',
    );
  }

  return user;
}

// ---------------------------------------------------------------- สมัคร / เข้าสู่ระบบ

/**
 * ผู้ใช้ 1 คน = Rating ครบ 4 cube_type (database-schema.md ตารางที่ 6)
 * ต้องเรียกใน **ทรานแซกชันเดียวกับที่สร้าง User เสมอ** — ทั้งสมัครด้วยรหัสผ่านและสมัครด้วย Google
 */
export async function createInitialRatings(
  tx: Prisma.TransactionClient,
  userId: number,
): Promise<void> {
  await tx.rating.createMany({
    data: ALL_CUBE_TYPES.map((cubeType) => ({ userId, cubeType, eloRating: ELO_INITIAL_RATING })),
  });
}

export async function register(
  input: RegisterInput,
  deviceLabel?: string,
): Promise<AuthSessionDto> {
  // เช็คซ้ำล่วงหน้าเพื่อบอกผู้ใช้ได้ว่าฟิลด์ไหนซ้ำ — unique index ใน DB ยังเป็นด่านสุดท้ายอยู่
  const existing = await prisma.user.findFirst({
    where: { OR: [{ username: input.username }, { email: input.email }] },
    select: { username: true, email: true },
  });
  if (existing) {
    throw existing.username === input.username
      ? errors.conflict('ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว', { username: 'ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว' })
      : errors.conflict('อีเมลนี้ถูกใช้ไปแล้ว', { email: 'อีเมลนี้ถูกใช้ไปแล้ว' });
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username: input.username,
        email: input.email,
        passwordHash,
        nickname: input.nickname ?? null,
      },
    });

    await createInitialRatings(tx, created.userId);
    return created;
  });

  return issueSession(user, deviceLabel);
}

export async function login(input: LoginInput, deviceLabel?: string): Promise<AuthSessionDto> {
  const identifier = input.identifier.trim();
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ username: identifier }, { email: identifier.toLowerCase() }],
      deletedAt: null,
    },
  });

  if (!user) throw errors.unauthenticated(INVALID_CREDENTIALS);

  // ผู้ใช้ Google ไม่มีรหัสผ่าน — ต้องบอกให้ตรง ไม่ใช่ "รหัสผ่านผิด" (ADR-012)
  // รวมบัญชีที่เพิ่งผูก Google แล้วรหัสผ่านเดิมถูกล้าง (ADR-058 ข้อ 4) → บอกทางตั้งรหัสใหม่ด้วย
  if (!user.passwordHash) {
    throw errors.unauthenticated(
      'บัญชีนี้ยังไม่มีรหัสผ่าน กรุณาเข้าสู่ระบบด้วย Google หรือตั้งรหัสผ่านผ่าน "ลืมรหัสผ่าน?"',
    );
  }

  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) throw errors.unauthenticated(INVALID_CREDENTIALS);

  const usable = await assertUsable(user);
  return issueSession(usable, deviceLabel);
}

// ---------------------------------------------------------------- refresh / logout

/**
 * Token rotation (ADR-013): ออก token ใหม่ทุกครั้ง แล้วปิด token เก่าพร้อมชี้ replaced_by
 * ถ้ามีคนเอา token ที่ถูกเพิกถอนไปแล้วมาใช้ = token ถูกขโมย → เพิกถอนทั้งหมดของผู้ใช้คนนั้นทันที
 */
export async function refreshSession(
  refreshToken: string,
  deviceLabel?: string,
): Promise<AuthSessionDto> {
  const payload = verifyRefreshToken(refreshToken);
  const tokenHash = hashToken(refreshToken);

  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row || row.userId !== payload.sub) {
    throw errors.unauthenticated('refresh token ไม่ถูกต้อง');
  }

  if (row.revokedAt) {
    await revokeAllRefreshTokens(row.userId);
    throw errors.unauthenticated(
      'ตรวจพบการใช้ refresh token ซ้ำ ระบบเพิกถอนทุกเซสชันแล้ว กรุณาเข้าสู่ระบบใหม่',
    );
  }

  if (row.expiresAt <= new Date()) {
    throw errors.unauthenticated('refresh token หมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }

  const user = await prisma.user.findUnique({ where: { userId: row.userId } });
  if (!user) throw errors.unauthenticated('ไม่พบบัญชีผู้ใช้');
  const usable = await assertUsable(user);

  const accessToken = signAccessToken({
    sub: usable.userId,
    username: usable.username,
    role: USER_ROLE_TO_API[usable.role],
  });
  const nextToken = signRefreshToken({ sub: usable.userId, jti: newJti() });

  await prisma.$transaction(async (tx) => {
    const created = await tx.refreshToken.create({
      data: {
        userId: usable.userId,
        tokenHash: hashToken(nextToken),
        expiresAt: new Date(Date.now() + parseDurationMs(env.jwt.refreshExpires)),
        deviceLabel: deviceLabel?.slice(0, 100) ?? row.deviceLabel,
      },
    });
    await tx.refreshToken.update({
      where: { tokenId: row.tokenId },
      data: { revokedAt: new Date(), replacedBy: created.tokenId },
    });
  });

  return { user: toSelfUser(usable), accessToken, refreshToken: nextToken };
}

/** ออกจากระบบเฉพาะเครื่องนี้ — ไม่มี token ส่งมาก็ถือว่าสำเร็จ (idempotent) */
export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function logoutAllDevices(userId: number): Promise<void> {
  await revokeAllRefreshTokens(userId);
}

// ---------------------------------------------------------------- รหัสผ่าน / ลบบัญชี

export async function changePassword(
  userId: number,
  currentPassword: string | undefined,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { userId } });
  if (!user || user.deletedAt) throw errors.notFound('ไม่พบบัญชีผู้ใช้');

  if (user.passwordHash) {
    if (!currentPassword) {
      throw errors.validation('กรุณากรอกรหัสผ่านเดิม', {
        currentPassword: 'กรุณากรอกรหัสผ่านเดิม',
      });
    }
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) {
      throw errors.validation('รหัสผ่านเดิมไม่ถูกต้อง', {
        currentPassword: 'รหัสผ่านเดิมไม่ถูกต้อง',
      });
    }
  }
  // ผู้ใช้ OAuth ที่ยังไม่เคยตั้งรหัสผ่าน → ตั้งใหม่ได้เลยโดยไม่ต้องใส่รหัสเดิม

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { userId }, data: { passwordHash } });
    // เปลี่ยนรหัสผ่านแล้วต้องเตะทุกอุปกรณ์ออก (ADR-013)
    await revokeAllRefreshTokens(userId, tx);
  });
}

/**
 * ลบบัญชีตัวเอง — soft delete ตาม ADR-008
 * ห้ามลบแถวจริง ไม่งั้นประวัติการแข่งของคู่แข่งพังไปด้วย (Match.player1_id เป็น NOT NULL + FK)
 */
export async function deleteAccount(userId: number, password: string | undefined): Promise<void> {
  const user = await prisma.user.findUnique({ where: { userId } });
  if (!user || user.deletedAt) throw errors.notFound('ไม่พบบัญชีผู้ใช้');

  if (user.passwordHash) {
    if (!password) {
      throw errors.validation('กรุณากรอกรหัสผ่านเพื่อยืนยัน', {
        password: 'กรุณากรอกรหัสผ่านเพื่อยืนยัน',
      });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw errors.validation('รหัสผ่านไม่ถูกต้อง', { password: 'รหัสผ่านไม่ถูกต้อง' });
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { userId },
      data: {
        deletedAt: new Date(),
        status: UserStatus.SUSPENDED,
        username: `deleted_user_${userId}`,
        email: `deleted_${userId}@cubeduel.local`,
        passwordHash: null,
        nickname: null,
      },
    });
    // ตัดการผูก Google/Facebook ทิ้ง ไม่งั้นล็อกอินกลับเข้ามาได้อีก
    await tx.oAuthAccount.deleteMany({ where: { userId } });
    await revokeAllRefreshTokens(userId, tx);
  });
}
