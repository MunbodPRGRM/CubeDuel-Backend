import { z } from 'zod';
import { INT4_MAX, dbIdSchema } from './common.schema.js';

/** กฎ validation ของระบบรายงานผู้เล่น (docs/api-contract.md ข้อ 8) */

/** id ที่มากับ body เป็นตัวเลขของ JSON อยู่แล้ว ไม่ต้อง coerce — แต่ต้องไม่เกิน INT4 เหมือนกัน (ADR-055 ข้อ 2) */
const bodyId = () => z.number().int().positive().max(INT4_MAX);

export const createReportSchema = z
  .object({
    reportedUserId: z
      .number({ required_error: 'ต้องระบุผู้ถูกรายงาน' })
      .int()
      .positive()
      .max(INT4_MAX),
    reason: z
      .string({ required_error: 'กรุณากรอกเหตุผล' })
      .trim()
      .min(10, 'เหตุผลต้องยาว 10–1000 ตัวอักษร')
      .max(1000, 'เหตุผลต้องยาว 10–1000 ตัวอักษร'),
    matchId: bodyId().nullish(),
    multiplayerMatchId: bodyId().nullish(),
  })
  .refine(
    (v) => !(v.matchId && v.multiplayerMatchId),
    // ตาราง `Report` มีสองคอลัมน์แยกกันเพราะ id ของสองระบบแมตช์ชนกันได้ (ADR-044 ข้อ 1)
    { message: 'แนบแมตช์ได้อย่างมากช่องเดียว', path: ['matchId'] },
  );

export const adminReportsQuerySchema = z.object({
  status: z.enum(['pending', 'resolved', 'all']).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * ตัดสินรายงาน — **ไม่รับ `reportStatus`** เพราะตัดสินแล้วเป็น `resolved` เสมอ
 * ไม่มีทางกลับไป `pending` (ADR-050 ข้อ 2)
 */
export const resolveReportSchema = z
  .object({
    action: z.enum(['none', 'warning', 'suspend', 'reset_rating'], {
      required_error: 'ต้องระบุผลการตัดสิน',
      invalid_type_error: 'ผลการตัดสินไม่ถูกต้อง',
    }),
    adminNote: z.string().trim().max(1000, 'บันทึกของแอดมินยาวเกินไป').nullish(),
    /** ใช้กับ `action=suspend` เท่านั้น · `null`/ไม่ส่ง = ระงับถาวร */
    suspendedUntil: z.coerce.date().nullish(),
  })
  .refine((v) => v.action === 'suspend' || !v.suspendedUntil, {
    message: 'ตั้งวันสิ้นสุดการระงับได้เฉพาะตอนสั่งระงับบัญชี',
    path: ['suspendedUntil'],
  });

export const reportIdParamSchema = dbIdSchema('reportId');

export type CreateReportInput = z.infer<typeof createReportSchema>;
export type AdminReportsQueryInput = z.infer<typeof adminReportsQuerySchema>;
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;
