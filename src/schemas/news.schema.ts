import { z } from 'zod';
import { NEWS_COVERS } from '../constants.js';
import { dbIdSchema } from './common.schema.js';

/**
 * กฎ validation ของข่าวสาร (docs/api-contract.md ข้อ 7)
 *
 * รับ JSON อย่างเดียว — เลิกอัปโหลดรูปแล้ว ปกเป็นคีย์ที่เว็บวาดให้ (ADR-084)
 * ฟิลด์ที่ไม่รู้จัก (`image` · `removeImage` ของรุ่นเก่า) ถูก `z.object` ตัดทิ้งเงียบ ๆ
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

const cover = z.enum(NEWS_COVERS, {
  errorMap: () => ({ message: 'ไม่รู้จักปกข่าวนี้' }),
});

export const newsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const newsIdParamSchema = dbIdSchema('newsId');

/** ไม่ส่ง `cover` = ใช้ค่าเริ่มต้นของคอลัมน์ (`general`) */
export const createNewsSchema = z.object({ title, content, cover: cover.optional() });

/** "ต้องมีอย่างน้อยหนึ่งช่อง" เช็คที่ `updateNews()` — ข้อความ error เดิม ("ไม่มีอะไรให้แก้") อยู่ที่นั่น */
export const updateNewsSchema = z.object({
  title: title.optional(),
  content: content.optional(),
  cover: cover.optional(),
});

export type NewsListQueryInput = z.infer<typeof newsListQuerySchema>;
export type CreateNewsInput = z.infer<typeof createNewsSchema>;
export type UpdateNewsInput = z.infer<typeof updateNewsSchema>;
