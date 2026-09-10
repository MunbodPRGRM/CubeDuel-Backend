import { z } from 'zod';

/**
 * กฎ validation ของข่าวสาร (docs/api-contract.md ข้อ 7)
 *
 * ฟอร์มของแอดมินส่งมาได้ทั้ง JSON และ `multipart/form-data` — **ค่าที่มาจาก multipart เป็น string เสมอ**
 * (`removeImage` จึงรับ `"true"`/`"false"` ไม่ใช่ boolean แท้)
 */

const title = z
  .string({ required_error: 'กรุณากรอกหัวข้อข่าว' })
  .trim()
  .min(1, 'กรุณากรอกหัวข้อข่าว')
  .max(150, 'หัวข้อข่าวต้องยาวไม่เกิน 150 ตัวอักษร');

/** เนื้อข่าวเป็น **ข้อความล้วน** ไม่ใช่ HTML (ADR-049 ข้อ 3) — เพดาน 20,000 ตัวกันคนวางนิยายทั้งเล่ม */
const content = z
  .string({ required_error: 'กรุณากรอกเนื้อหาข่าว' })
  .trim()
  .min(1, 'กรุณากรอกเนื้อหาข่าว')
  .max(20_000, 'เนื้อหาข่าวยาวเกินไป (สูงสุด 20,000 ตัวอักษร)');

const removeImage = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true')
  .optional();

export const newsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const newsIdParamSchema = z.coerce
  .number({ invalid_type_error: 'newsId ต้องเป็นตัวเลข' })
  .int()
  .positive();

export const createNewsSchema = z.object({ title, content, removeImage });

/**
 * **ไม่มี `.refine` ว่า "ต้องมีอย่างน้อยหนึ่งช่อง"** ตรงนี้โดยตั้งใจ —
 * การส่งมาแค่ไฟล์รูป (ไม่มีช่องข้อความเลย) เป็นการแก้ที่ถูกต้อง แต่ schema มองไม่เห็นไฟล์
 * → ย้ายไปเช็คที่ `updateNews()` ซึ่งเห็นทั้งสองอย่าง (ADR-049 ข้อ 5)
 */
export const updateNewsSchema = z.object({
  title: title.optional(),
  content: content.optional(),
  removeImage,
});

export type NewsListQueryInput = z.infer<typeof newsListQuerySchema>;
export type CreateNewsInput = z.infer<typeof createNewsSchema>;
export type UpdateNewsInput = z.infer<typeof updateNewsSchema>;
