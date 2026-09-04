import { Router } from 'express';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { toSelfUser } from '../types/api.js';

export const usersRouter = Router();

/** ข้อมูลตัวเองแบบเต็ม รวม email (api-contract.md ข้อ 3) */
usersRouter.get('/me', requireAuth, (req, res) => {
  res.json({ data: toSelfUser(currentUser(req)) });
});

// TODO(เฟส 8): PATCH /me (nickname, cubeSkin)
// TODO(เฟส 7): GET /:userId, /:userId/ratings, /:userId/stats, /:userId/matches
