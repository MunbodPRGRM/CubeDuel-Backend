import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { reportLimiter } from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import { createReportSchema, type CreateReportInput } from '../schemas/report.schema.js';
import { createReport } from '../services/report.service.js';

/** แจ้งรายงานผู้เล่น — ฝั่งผู้ใช้ (api-contract.md ข้อ 8) */
export const reportsRouter = Router();

reportsRouter.post(
  '/',
  requireAuth,
  // กันคนสแปมรายงานคนอื่นรัว ๆ จนหน้าแอดมินใช้งานไม่ได้ (api-contract.md ข้อ 11)
  reportLimiter,
  validateBody(createReportSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as CreateReportInput;
    // ห้ามเชื่อ userId ที่มาใน payload — ผู้แจ้งคือคนที่ถือ token เท่านั้น
    const report = await createReport(currentUser(req).userId, input);
    res.status(201).json({ data: report });
  }),
);
