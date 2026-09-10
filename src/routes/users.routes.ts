import { Router } from 'express';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { queryOf, validateQuery } from '../middleware/validate.js';
import { userIdParamSchema } from '../schemas/leaderboard.schema.js';
import {
  matchHistoryQuerySchema,
  userStatsQuerySchema,
  type MatchHistoryQueryInput,
  type UserStatsQueryInput,
} from '../schemas/stats.schema.js';
import { getUserRatings } from '../services/leaderboard.service.js';
import { getUserMatchHistory, getUserStats } from '../services/stats.service.js';
import { getPublicProfile } from '../services/user.service.js';
import { toSelfUser } from '../types/api.js';

export const usersRouter = Router();

/** ข้อมูลตัวเองแบบเต็ม รวม email (api-contract.md ข้อ 3) */
usersRouter.get('/me', requireAuth, (req, res) => {
  res.json({ data: toSelfUser(currentUser(req)) });
});

/**
 * สถิติของผู้ใช้คนหนึ่งในประเภทรูบิคหนึ่ง (api-contract.md ข้อ 4)
 * ต้องมาก่อน `/:userId` ไม่งั้น path ที่ยาวกว่าจะไม่มีวันถูกเรียก
 */
usersRouter.get(
  '/:userId/stats',
  validateQuery(userStatsQuerySchema),
  asyncHandler(async (req, res) => {
    const userId = userIdParamSchema.parse(req.params.userId);
    const q = queryOf<typeof userStatsQuerySchema>(req) as UserStatsQueryInput;
    res.json({ data: await getUserStats(userId, q.cubeType) });
  }),
);

/** ประวัติการแข่ง รวมทั้งแมตช์ 1v1 และแมตช์ผู้เล่นหลายคน (api-contract.md ข้อ 3) */
usersRouter.get(
  '/:userId/matches',
  validateQuery(matchHistoryQuerySchema),
  asyncHandler(async (req, res) => {
    const userId = userIdParamSchema.parse(req.params.userId);
    const q = queryOf<typeof matchHistoryQuerySchema>(req) as MatchHistoryQueryInput;
    res.json(await getUserMatchHistory(userId, q));
  }),
);

/** คะแนน Elo ทั้ง 4 ประเภท + อันดับของแต่ละประเภท (api-contract.md ข้อ 3) */
usersRouter.get(
  '/:userId/ratings',
  asyncHandler(async (req, res) => {
    const userId = userIdParamSchema.parse(req.params.userId);
    res.json({ data: await getUserRatings(userId) });
  }),
);

/** โปรไฟล์สาธารณะ — ไม่มี email (api-contract.md ข้อ 3) */
usersRouter.get(
  '/:userId',
  asyncHandler(async (req, res) => {
    const userId = userIdParamSchema.parse(req.params.userId);
    res.json({ data: await getPublicProfile(userId) });
  }),
);

// TODO(เฟส 8): PATCH /me (nickname, cubeSkin)
