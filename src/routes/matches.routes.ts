import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/async-handler.js';
import { getMatchDetail, getMultiplayerMatchDetail } from '../services/match.service.js';

export const matchesRouter = Router();
export const multiplayerMatchesRouter = Router();

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

/**
 * ผลของแมตช์ผู้เล่นหลายคนหนึ่งแมตช์ (api-contract.md ข้อ 3)
 *
 * **แยก endpoint จาก `/matches/:matchId` เพราะเป็นคนละตารางที่ id ชนกันได้** — ถ้ารวมกัน
 * แล้วแยกด้วย query param การลืมส่ง param หนึ่งครั้งแปลว่าผู้เล่นเห็นผลของแมตช์อื่นเงียบ ๆ
 * (ADR-044 ข้อ 1) · เปิดสาธารณะเหมือนกัน ไม่มีข้อมูลส่วนตัวอยู่ในผลแมตช์
 */
multiplayerMatchesRouter.get(
  '/:multiplayerMatchId',
  asyncHandler(async (req, res) => {
    const id = matchIdParamSchema.parse(req.params.multiplayerMatchId);
    res.json({ data: await getMultiplayerMatchDetail(id) });
  }),
);
