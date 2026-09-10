/**
 * งานเบื้องหลังที่ต้องเดินเองเป็นระยะ (เฟส 10 ก้อนที่ 1)
 *
 *   1. ปลดระงับบัญชีที่ครบกำหนด `suspended_until` (ADR-050 ข้อ 10)
 *   2. ล้าง `MatchFlag.move_log` ที่เก็บครบ 90 วัน โดย**คงแถว flag ไว้** (game-rules.md ข้อ 10)
 *
 * ทั้งสองตัวเป็นฟังก์ชันธรรมดาที่รับ `now` เข้ามา — ตัวจับเวลาอยู่ที่ `scheduler.ts`
 * เรียกซ้ำกี่รอบก็ได้ผลเท่าเดิม (idempotent) เพราะเงื่อนไข `where` ตัดแถวที่ทำไปแล้วออกเอง
 */
import { Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { MOVE_LOG_RETENTION_DAYS } from '../constants.js';

/** วันสุดท้ายที่ยัง**เก็บ** move log ไว้ — แถวที่เก่ากว่านี้ถูกล้าง */
export function moveLogCutoff(now: Date): Date {
  return new Date(now.getTime() - MOVE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
}

/**
 * ปลดระงับบัญชีที่ถึงเวลาแล้ว — คืนจำนวนแถวที่ปลด
 *
 * `assertUsable()` ปลดให้อยู่แล้วตอนเจ้าตัวเข้าใช้งาน job นี้มีไว้ให้**หน้าจอแอดมินกับข้อมูลใน DB
 * ตรงกับความจริง**แม้เจ้าตัวจะไม่กลับมาล็อกอินอีกเลย (ไม่งั้นแถวนั้นค้างเป็น SUSPENDED ตลอดไป)
 *
 * ไม่เขียน `AdminAuditLog` เพราะคอลัมน์ `admin_id` เป็น NOT NULL — การปลดตามกำหนดเวลา
 * ไม่มีแอดมินคนไหนเป็นเจ้าของการกระทำ (ADR-052 ข้อ 3)
 */
export async function unsuspendExpiredAccounts(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.user.updateMany({
    where: {
      status: UserStatus.SUSPENDED,
      deletedAt: null,
      // NULL = ระงับถาวร ต้องไม่โดนปลด (database-schema.md ตารางที่ 1)
      suspendedUntil: { not: null, lte: now },
    },
    data: { status: UserStatus.ACTIVE, suspendedUntil: null },
  });
  return count;
}

/**
 * ล้าง move log ที่หมดอายุการเก็บ — คืนจำนวนแถวที่ล้าง
 *
 * **ล้างเฉพาะคอลัมน์ `move_log` ห้ามลบแถว** เพราะประวัติว่าเคยถูก flag ด้วยเหตุอะไรและแอดมิน
 * ตัดสินว่ายังไงต้องอยู่ต่อไป (game-rules.md ข้อ 10) · `DbNull` = NULL ของคอลัมน์ ไม่ใช่ค่า JSON null
 */
export async function purgeExpiredMoveLogs(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.matchFlag.updateMany({
    where: { createdAt: { lt: moveLogCutoff(now) }, moveLog: { not: Prisma.DbNull } },
    data: { moveLog: Prisma.DbNull },
  });
  return count;
}
