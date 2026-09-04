import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { queryOf, validateQuery } from '../middleware/validate.js';
import {
  leaderboardQuerySchema,
  type LeaderboardQueryInput,
} from '../schemas/leaderboard.schema.js';
import { getLeaderboard } from '../services/leaderboard.service.js';

export const leaderboardRouter = Router();

/** GET /leaderboard?cubeType=3x3x3&scope=all&sortBy=elo&page=1&limit=50 (api-contract.md ข้อ 5) */
leaderboardRouter.get(
  '/',
  validateQuery(leaderboardQuerySchema),
  asyncHandler(async (req, res) => {
    const q = queryOf<typeof leaderboardQuerySchema>(req) as LeaderboardQueryInput;
    res.json(await getLeaderboard(q));
  }),
);
