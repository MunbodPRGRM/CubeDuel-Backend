import { Router } from 'express';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// TODO(เฟส 2): router.use('/auth', authRouter)
// TODO(เฟส 3): router.get('/scramble', ...)
// TODO(เฟส 7): stats + leaderboard
// TODO(เฟส 8): profile / news / reports / admin
