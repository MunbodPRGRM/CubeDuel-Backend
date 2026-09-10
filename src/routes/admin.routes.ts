import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { currentUser, requireAdmin, requireAuth } from '../middleware/auth.js';
import { newsImageField } from '../middleware/upload.js';
import { queryOf, validateBody, validateQuery } from '../middleware/validate.js';
import { deleteNewsImage, saveNewsImage } from '../lib/uploads.js';
import { userIdParamSchema } from '../schemas/leaderboard.schema.js';
import {
  adminUsersQuerySchema,
  flaggedQuerySchema,
  flagIdParamSchema,
  reviewFlagSchema,
  updateUserRatingSchema,
  updateUserStatusSchema,
  type AdminUsersQueryInput,
  type FlaggedQueryInput,
  type ReviewFlagInput,
  type UpdateUserRatingInput,
  type UpdateUserStatusInput,
} from '../schemas/admin.schema.js';
import {
  adminReportsQuerySchema,
  reportIdParamSchema,
  resolveReportSchema,
  type AdminReportsQueryInput,
  type ResolveReportInput,
} from '../schemas/report.schema.js';
import {
  getDashboard,
  getFlag,
  listFlags,
  listUsers,
  reviewFlag,
  setUserRating,
  setUserStatus,
} from '../services/admin.service.js';
import { listReports, resolveReport } from '../services/report.service.js';
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

// ---------------------------------------------------------------- แดชบอร์ด

/** ตัวเลขสรุประบบ — `activeRooms`/`onlineUsers` มาจาก memory ของ Socket.IO ไม่ใช่ DB */
adminRouter.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    res.json({ data: await getDashboard() });
  }),
);

// ---------------------------------------------------------------- จัดการบัญชี

adminRouter.get(
  '/users',
  validateQuery(adminUsersQuerySchema),
  asyncHandler(async (req, res) => {
    const q = queryOf<typeof adminUsersQuerySchema>(req) as AdminUsersQueryInput;
    res.json(await listUsers(q));
  }),
);

adminRouter.patch(
  '/users/:userId/status',
  validateBody(updateUserStatusSchema),
  asyncHandler(async (req, res) => {
    const userId = userIdParamSchema.parse(req.params.userId);
    const input = req.body as UpdateUserStatusInput;
    res.json({ data: await setUserStatus(currentUser(req).userId, userId, input) });
  }),
);

adminRouter.patch(
  '/users/:userId/rating',
  validateBody(updateUserRatingSchema),
  asyncHandler(async (req, res) => {
    const userId = userIdParamSchema.parse(req.params.userId);
    const input = req.body as UpdateUserRatingInput;
    res.json({ data: await setUserRating(currentUser(req).userId, userId, input) });
  }),
);

// ---------------------------------------------------------------- รายงานผู้เล่น

adminRouter.get(
  '/reports',
  validateQuery(adminReportsQuerySchema),
  asyncHandler(async (req, res) => {
    const q = queryOf<typeof adminReportsQuerySchema>(req) as AdminReportsQueryInput;
    res.json(await listReports(q));
  }),
);

adminRouter.patch(
  '/reports/:reportId',
  validateBody(resolveReportSchema),
  asyncHandler(async (req, res) => {
    const reportId = reportIdParamSchema.parse(req.params.reportId);
    const input = req.body as ResolveReportInput;
    res.json({ data: await resolveReport(currentUser(req).userId, reportId, input) });
  }),
);

// ---------------------------------------------------------------- แมตช์ที่ถูก flag

adminRouter.get(
  '/matches/flagged',
  validateQuery(flaggedQuerySchema),
  asyncHandler(async (req, res) => {
    const q = queryOf<typeof flaggedQuerySchema>(req) as FlaggedQueryInput;
    res.json(await listFlags(q));
  }),
);

/** ทีละใบ — ตัวเดียวที่ส่ง `moveLog` เต็มออกไป (ADR-050 ข้อ 5) */
adminRouter.get(
  '/matches/flagged/:flagId',
  asyncHandler(async (req, res) => {
    const flagId = flagIdParamSchema.parse(req.params.flagId);
    res.json({ data: await getFlag(flagId) });
  }),
);

adminRouter.patch(
  '/matches/flagged/:flagId',
  validateBody(reviewFlagSchema),
  asyncHandler(async (req, res) => {
    const flagId = flagIdParamSchema.parse(req.params.flagId);
    const input = req.body as ReviewFlagInput;
    res.json({ data: await reviewFlag(currentUser(req).userId, flagId, input) });
  }),
);
