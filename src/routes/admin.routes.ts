import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { currentUser, requireAdmin, requireAuth } from '../middleware/auth.js';
import { newsImageField } from '../middleware/upload.js';
import { validateBody } from '../middleware/validate.js';
import { deleteNewsImage, saveNewsImage } from '../lib/uploads.js';
import {
  createNewsSchema,
  newsIdParamSchema,
  updateNewsSchema,
  type CreateNewsInput,
  type UpdateNewsInput,
} from '../schemas/news.schema.js';
import { createNews, deleteNews, updateNews } from '../services/news.service.js';

/**
 * ทุกอย่างใต้ `/admin` (api-contract.md ข้อ 7 และ 9)
 *
 * **กฎของทั้งไฟล์:** endpoint ไหนเปลี่ยนข้อมูล ต้องเขียน `AdminAuditLog` ในทรานแซกชันเดียวกัน
 * → เขียนไว้ที่ชั้น service เสมอ ไม่ใช่ที่นี่ (ADR-017)
 */
export const adminRouter = Router();

// กันทั้ง router ไว้ชั้นเดียว จะได้ไม่มีวันลืมใส่ทีละ endpoint
adminRouter.use(requireAuth, requireAdmin);

/**
 * บันทึกรูป (ถ้ามี) ลงดิสก์ก่อน แล้วค่อยแตะ DB — ถ้า DB พังต้องลบไฟล์ที่เพิ่งเขียนทิ้ง
 * ไม่งั้นทุก request ที่ล้มเหลวจะทิ้งไฟล์ขยะไว้บนเครื่อง
 */
async function withSavedImage<T>(
  file: Express.Multer.File | undefined,
  run: (imagePath: string | null) => Promise<T>,
): Promise<T> {
  const imagePath = file ? await saveNewsImage(file) : null;
  try {
    return await run(imagePath);
  } catch (err) {
    await deleteNewsImage(imagePath);
    throw err;
  }
}

adminRouter.post(
  '/news',
  newsImageField,
  validateBody(createNewsSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as CreateNewsInput;
    const admin = currentUser(req);
    const news = await withSavedImage(req.file, (imagePath) =>
      createNews(admin.userId, input, imagePath),
    );
    res.status(201).json({ data: news });
  }),
);

adminRouter.patch(
  '/news/:newsId',
  newsImageField,
  validateBody(updateNewsSchema),
  asyncHandler(async (req, res) => {
    const newsId = newsIdParamSchema.parse(req.params.newsId);
    const input = req.body as UpdateNewsInput;
    const admin = currentUser(req);
    const news = await withSavedImage(req.file, (imagePath) =>
      updateNews(admin.userId, newsId, input, imagePath),
    );
    res.json({ data: news });
  }),
);

adminRouter.delete(
  '/news/:newsId',
  asyncHandler(async (req, res) => {
    const newsId = newsIdParamSchema.parse(req.params.newsId);
    await deleteNews(currentUser(req).userId, newsId);
    res.json({ data: { newsId, deleted: true } });
  }),
);

// TODO(เฟส 8 ก้อนที่ 3): /admin/dashboard · /admin/users · /admin/reports · /admin/matches/flagged
