import { z } from 'zod';

/**
 * เพดานของคอลัมน์ `Int` ใน Postgres (INT4) — id ทุกตัวในระบบเป็นชนิดนี้
 *
 * ถ้าไม่กันไว้ที่ชั้น validation เลขที่เกินจะหลุดไปถึง Prisma แล้วพังเป็น 500 พร้อม stack
 * (`GET /users/99999999999` เคยเป็นแบบนั้นจริง — ADR-055 ข้อ 2)
 */
export const INT4_MAX = 2_147_483_647;

/**
 * id ที่มากับ path (`/users/:userId`) — เป็น string เสมอจึงต้อง coerce
 * `label` ใช้ในข้อความ error เช่น "userId"
 */
export function dbIdSchema(label: string) {
  const message = `${label} ต้องเป็นตัวเลขที่ถูกต้อง`;
  return z.coerce
    .number({ invalid_type_error: message })
    .int(message)
    .positive(message)
    .max(INT4_MAX, message);
}
