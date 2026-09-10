import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { authRouter } from './auth.routes.js';
import { usersRouter } from './users.routes.js';
import { matchesRouter, multiplayerMatchesRouter } from './matches.routes.js';
import { leaderboardRouter } from './leaderboard.routes.js';
import { scrambleRouter } from './scramble.routes.js';
import { newsRouter } from './news.routes.js';
import { adminRouter } from './admin.routes.js';

export const router = Router();

/** api-contract.md ข้อ 10 — ตรวจว่า DB ต่อติดจริงด้วย ไม่ใช่แค่ process ยังอยู่ */
router.get('/health', async (_req, res) => {
  let db = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = 'down';
  }
  res.status(db === 'ok' ? 200 : 503).json({
    status: db === 'ok' ? 'ok' : 'degraded',
    db,
    uptime: Math.round(process.uptime()),
  });
});

router.use('/auth', authRouter);
router.use('/users', usersRouter);
router.use('/matches', matchesRouter);
router.use('/multiplayer-matches', multiplayerMatchesRouter);
router.use('/leaderboard', leaderboardRouter);
router.use('/scramble', scrambleRouter);
router.use('/news', newsRouter);
router.use('/admin', adminRouter);

// TODO(เฟส 8 ก้อนที่ 3): /reports (ฝั่งผู้ใช้) + endpoint ที่เหลือของ /admin
