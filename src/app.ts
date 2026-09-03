import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { router } from './routes/index.js';

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json());

  app.use('/api', router);

  // TODO(เฟส 10): error handler กลาง + หน้า error ที่อ่านรู้เรื่อง
  return app;
}
