import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { queryOf, validateQuery } from '../middleware/validate.js';
import { scrambleQuerySchema, type ScrambleQueryInput } from '../schemas/scramble.schema.js';
import { generateScrambles } from '../services/scramble.service.js';

export const scrambleRouter = Router();

/**
 * GET /scramble?cubeType=3x3x3&count=1 (api-contract.md ข้อ 6)
 * ใช้กับ **ห้องฝึกซ้อมเท่านั้น** — ห้องแข่งขัน server generate เองแล้วส่งผ่าน `match:loading`
 */
scrambleRouter.get(
  '/',
  requireAuth,
  validateQuery(scrambleQuerySchema),
  asyncHandler(async (req, res) => {
    const { cubeType, count } = queryOf<typeof scrambleQuerySchema>(req) as ScrambleQueryInput;
    res.json({ data: { cubeType, scrambles: await generateScrambles(cubeType, count) } });
  }),
);
