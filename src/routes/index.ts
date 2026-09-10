import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { authRouter } from './auth.routes.js';
import { usersRouter } from './users.routes.js';
import { matchesRouter, multiplayerMatchesRouter } from './matches.routes.js';
import { leaderboardRouter } from './leaderboard.routes.js';
import { scrambleRouter } from './scramble.routes.js';

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

// TODO(เฟส 7 ก้อนที่ 2): กระดานอันดับรายสัปดาห์ (scope=weekly)
// TODO(เฟส 8): news / reports / admin
