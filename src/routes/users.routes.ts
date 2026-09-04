import { Router } from 'express';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { userIdParamSchema } from '../schemas/leaderboard.schema.js';
import { getUserRatings } from '../services/leaderboard.service.js';
import { toSelfUser } from '../types/api.js';

export const usersRouter = Router();

/** ข้อมูลตัวเองแบบเต็ม รวม email (api-contract.md ข้อ 3) */
usersRouter.get('/me', requireAuth, (req, res) => {
  res.json({ data: toSelfUser(currentUser(req)) });
});

/** คะแนน Elo ทั้ง 4 ประเภท + อันดับของแต่ละประเภท (api-contract.md ข้อ 3) */
usersRouter.get(
  '/:userId/ratings',
  asyncHandler(async (req, res) => {
    const userId = userIdParamSchema.parse(req.params.userId);
    res.json({ data: await getUserRatings(userId) });
  }),
);

// TODO(เฟส 8): PATCH /me (nickname, cubeSkin)
// TODO(เฟส 7): GET /:userId, /:userId/stats, /:userId/matches
