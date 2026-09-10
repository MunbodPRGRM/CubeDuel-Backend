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

  /**
   * ไฟล์ที่แอดมินอัปโหลด (รูปข่าว) — อยู่นอก `/api/v1` เพราะเป็นไฟล์ ไม่ใช่ JSON
   * `index: false` กันไม่ให้เปิดดูรายชื่อไฟล์ในโฟลเดอร์ · `dotfiles: 'deny'` กันไฟล์ซ่อน
   */
  app.use(
    '/uploads',
    express.static(env.uploadsDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: env.isProduction ? '7d' : 0,
      // ชื่อไฟล์สุ่มไม่ซ้ำอยู่แล้ว รูปเดิมจึงไม่มีวันเปลี่ยนเนื้อ — cache ยาวได้
      immutable: env.isProduction,
    }),
  );

  app.use(API_BASE_PATH, router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
