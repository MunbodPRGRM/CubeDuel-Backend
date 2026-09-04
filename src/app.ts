import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { router } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

/** base path ตาม docs/api-contract.md ข้อ 1 */
export const API_BASE_PATH = '/api/v1';

export function createApp() {
  const app = express();

  // อยู่หลัง reverse proxy ตอน deploy — ไม่ตั้งค่านี้ rate limit จะเห็น IP ของ proxy เป็น IP เดียวกันหมด
  if (env.isProduction) app.set('trust proxy', 1);

  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use(API_BASE_PATH, router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
