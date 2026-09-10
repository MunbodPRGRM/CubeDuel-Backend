/**
 * สโมคเทสเฟส 10 ก้อนที่ 1 — งานเบื้องหลัง (`src/jobs/`)
 *
 *   npm run smoke:jobs
 *
 * **ไม่ต้องรัน `npm run dev`** เพราะงานเบื้องหลังไม่มี endpoint ให้ยิง — สคริปต์นี้จึงเป็น
 * ข้อยกเว้นของกติกา "สโมคเทสต้องคุยผ่านสายเดียวกับเบราว์เซอร์" แบบเดียวกับตอน `smoke:admin`
 * เปิด Prisma อ่าน `AdminAuditLog` ตรง ๆ (ADR-052 ข้อ 5)
 *
 * ต้องรัน `npm run seed` มาก่อน และเทสนี้**สร้างของจริงลง DB แล้วเก็บกวาดคืนตอนจบ**
 */
import 'dotenv/config';
import { FlagReason, UserStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import {
  moveLogCutoff,
  purgeExpiredMoveLogs,
  unsuspendExpiredAccounts,
} from '../src/jobs/maintenance.js';
import { MOVE_LOG_RETENTION_DAYS } from '../src/constants.js';
import { check, summary } from './smoke-helpers.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const now = new Date();
const daysAgo = (days: number): Date => new Date(now.getTime() - days * DAY_MS);
const daysAhead = (days: number): Date => new Date(now.getTime() + days * DAY_MS);

const SAMPLE_MOVE_LOG = [
  { seq: 1, move: 'R', ms: 120 },
  { seq: 2, move: "U'", ms: 240 },
];

async function findUser(username: string): Promise<{ userId: number }> {
  const user = await prisma.user.findUnique({ where: { username }, select: { userId: true } });
  if (!user) throw new Error(`ไม่พบบัญชี ${username} — รัน npm run seed ก่อน`);
  return user;
}

async function statusOf(userId: number) {
  return prisma.user.findUniqueOrThrow({
    where: { userId },
    select: { status: true, suspendedUntil: true },
  });
}

/** สร้างแถว flag ปลอมบนแมตช์ที่มีอยู่แล้ว — คืน `flagId` ไว้ลบตอนจบ */
async function createFlag(matchId: number, userId: number, createdAt: Date): Promise<number> {
  const flag = await prisma.matchFlag.create({
    data: {
      matchId,
      userId,
      flagReason: FlagReason.IMPOSSIBLE_TIME,
      detail: { metric: 'smoke', measured: 0, threshold: 0 },
      moveLog: SAMPLE_MOVE_LOG,
      createdAt,
    },
    select: { flagId: true },
  });
  return flag.flagId;
}

async function main(): Promise<number> {
  const target = await findUser('somchai');
  const ghost = await findUser('wanida');
  console.log('');

  // ---------------------------------------------------------------- ปลดระงับอัตโนมัติ

  console.log('1) ปลดระงับบัญชีที่ครบกำหนด');

  await prisma.user.update({
    where: { userId: target.userId },
    data: { status: UserStatus.SUSPENDED, suspendedUntil: daysAgo(1) },
  });
  const unsuspended = await unsuspendExpiredAccounts(now);
  const afterExpired = await statusOf(target.userId);
  check('ครบกำหนดแล้ว → job ปลดให้', unsuspended >= 1, unsuspended);
  check(
    'สถานะกลับเป็น ACTIVE และ suspended_until = NULL',
    afterExpired.status === UserStatus.ACTIVE && afterExpired.suspendedUntil === null,
    afterExpired,
  );

  await prisma.user.update({
    where: { userId: target.userId },
    data: { status: UserStatus.SUSPENDED, suspendedUntil: daysAhead(3) },
  });
  await unsuspendExpiredAccounts(now);
  const afterFuture = await statusOf(target.userId);
  check(
    'ยังไม่ถึงกำหนด → ยังระงับอยู่',
    afterFuture.status === UserStatus.SUSPENDED && afterFuture.suspendedUntil !== null,
    afterFuture,
  );

  await prisma.user.update({
    where: { userId: target.userId },
    data: { status: UserStatus.SUSPENDED, suspendedUntil: null },
  });
  await unsuspendExpiredAccounts(now);
  const afterPermanent = await statusOf(target.userId);
  check(
    'ระงับถาวร (suspended_until = NULL) → ห้ามโดนปลด',
    afterPermanent.status === UserStatus.SUSPENDED,
    afterPermanent,
  );

  // บัญชีที่ลบไปแล้วต้องไม่ถูกชุบกลับมาเป็น ACTIVE
  await prisma.user.update({
    where: { userId: ghost.userId },
    data: { status: UserStatus.SUSPENDED, suspendedUntil: daysAgo(2), deletedAt: now },
  });
  await unsuspendExpiredAccounts(now);
  const afterDeleted = await statusOf(ghost.userId);
  check(
    'บัญชีที่ถูกลบแล้ว → job ไม่แตะ',
    afterDeleted.status === UserStatus.SUSPENDED,
    afterDeleted,
  );

  // ---------------------------------------------------------------- ล้าง move log

  console.log('\n2) ล้าง move log ที่เก็บครบ 90 วัน');

  const cutoff = moveLogCutoff(now);
  check(
    `เส้นแบ่งอยู่ที่ ${MOVE_LOG_RETENTION_DAYS} วันก่อนหน้า`,
    Math.round((now.getTime() - cutoff.getTime()) / DAY_MS) === MOVE_LOG_RETENTION_DAYS,
    cutoff.toISOString(),
  );

  const match = await prisma.match.findFirst({ select: { matchId: true, player1Id: true } });
  if (!match) {
    console.log('  ⏭️  ยังไม่มีแมตช์ใน DB — ข้ามส่วนนี้ (เล่นให้จบสักแมตช์แล้วรันใหม่)');
    return summary('(ข้ามส่วน move log)');
  }

  const oldFlagId = await createFlag(match.matchId, match.player1Id, daysAgo(91));
  const freshFlagId = await createFlag(match.matchId, match.player1Id, daysAgo(89));
  const purged = await purgeExpiredMoveLogs(now);
  const oldFlag = await prisma.matchFlag.findUnique({ where: { flagId: oldFlagId } });
  const freshFlag = await prisma.matchFlag.findUnique({ where: { flagId: freshFlagId } });

  check('มีแถวถูกล้างอย่างน้อย 1 แถว', purged >= 1, purged);
  check('flag เก่ากว่า 90 วัน → move_log เป็น NULL', oldFlag?.moveLog === null, oldFlag?.moveLog);
  check('แต่แถว flag ยังอยู่ (ห้ามลบทิ้ง)', oldFlag !== null);
  check(
    'flag ที่ยังไม่ถึง 90 วัน → move_log ยังอยู่ครบ',
    Array.isArray(freshFlag?.moveLog) && freshFlag.moveLog.length === SAMPLE_MOVE_LOG.length,
    freshFlag?.moveLog,
  );

  const purgedAgain = await purgeExpiredMoveLogs(now);
  check('รันซ้ำแล้วไม่มีอะไรเหลือให้ล้าง (idempotent)', purgedAgain === 0, purgedAgain);

  await prisma.matchFlag.deleteMany({ where: { flagId: { in: [oldFlagId, freshFlagId] } } });
  return summary();
}

/** คืนสถานะบัญชีที่ยืมมาทดสอบให้เหมือนเดิมเสมอ ไม่ว่าเทสจะพังตรงไหน */
async function restore(): Promise<void> {
  const target = await prisma.user.findUnique({ where: { username: 'somchai' } });
  const ghost = await prisma.user.findUnique({ where: { username: 'wanida' } });
  if (target) {
    await prisma.user.update({
      where: { userId: target.userId },
      data: { status: UserStatus.ACTIVE, suspendedUntil: null },
    });
  }
  if (ghost) {
    await prisma.user.update({
      where: { userId: ghost.userId },
      data: { status: UserStatus.ACTIVE, suspendedUntil: null, deletedAt: null },
    });
  }
}

main()
  .then(async (code) => {
    await restore();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await restore().catch(() => undefined);
    process.exit(1);
  });
