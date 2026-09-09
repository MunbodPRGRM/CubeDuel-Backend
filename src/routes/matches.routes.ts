import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/async-handler.js';
import { getMatchDetail } from '../services/match.service.js';

export const matchesRouter = Router();

const matchIdParamSchema = z.coerce
  .number({ invalid_type_error: 'matchId ต้องเป็นตัวเลข' })
  .int()
  .positive();

/**
 * ผลของแมตช์ 1v1 หนึ่งแมตช์ (api-contract.md ข้อ 3)
 * เปิดสาธารณะเหมือนกระดานอันดับ — ไม่มีข้อมูลส่วนตัวอยู่ในผลแมตช์
 */
matchesRouter.get(
  '/:matchId',
  asyncHandler(async (req, res) => {
    const matchId = matchIdParamSchema.parse(req.params.matchId);
    res.json({ data: await getMatchDetail(matchId) });
  }),
);
