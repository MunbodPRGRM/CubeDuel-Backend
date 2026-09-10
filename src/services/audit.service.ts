import type { Prisma } from '@prisma/client';

/**
 * `AdminAuditLog` — ทุก endpoint ใต้ `/admin` ที่ **เปลี่ยนข้อมูล** ต้องเขียนแถวนี้
 * **ในทรานแซกชันเดียวกับที่เปลี่ยนข้อมูล** (ADR-017 · api-contract.md ข้อ 9)
 *
 * เขียนนอกทรานแซกชันไม่ได้ เพราะจะเกิดกรณี "แก้ข้อมูลสำเร็จแต่ log หาย" หรือกลับกัน
 * → ฟังก์ชันนี้จึงรับ `tx` เป็นพารามิเตอร์แรกเสมอ ไม่ได้เรียก `prisma` ตรง ๆ
 */
export type AuditAction =
  | 'suspend_user'
  | 'unsuspend_user'
  | 'edit_rating'
  | 'resolve_report'
  | 'review_flag'
  | 'create_news'
  | 'update_news'
  | 'delete_news';

export interface AuditEntry {
  adminId: number;
  action: AuditAction;
  /** ผู้ใช้ที่ถูกกระทำ — ข่าวสารไม่มีเป้าหมายเป็นผู้ใช้ จึงเป็น `null` ได้ */
  targetUserId?: number | null;
  /** ค่าเก่า/ค่าใหม่ หรือรายละเอียดอื่นที่ทำให้ย้อนดูแล้วเข้าใจว่าเกิดอะไรขึ้น */
  detail?: Prisma.InputJsonValue;
}

export function writeAuditLog(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<unknown> {
  return tx.adminAuditLog.create({
    data: {
      adminId: entry.adminId,
      action: entry.action,
      targetUserId: entry.targetUserId ?? null,
      detail: entry.detail,
    },
  });
}
