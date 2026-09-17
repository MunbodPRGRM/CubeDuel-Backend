import express, { type RequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { router } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

/** base path ตาม docs/api-contract.md ข้อ 1 */
export const API_BASE_PATH = '/api/v1';

/**
 * header ความปลอดภัยพื้นฐาน — เขียนเองสามบรรทัดแทนการลง helmet (ADR-055 ข้อ 4)
 * backend นี้ส่งแค่ JSON ไม่มีหน้า HTML ให้ต้องตั้ง CSP · ไม่เสิร์ฟไฟล์แล้ว (ADR-084)
 *   - nosniff: เบราว์เซอร์ต้องเชื่อ Content-Type ห้ามเดาเอง
 *   - DENY: ไม่มีอะไรของ backend ที่ควรถูกฝังใน iframe
 *   - no-referrer: URL ของ API ไม่ต้องติดไปกับลิงก์ออกนอก
 */
const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};

export function createApp() {
  const app = express();

  // อยู่หลัง reverse proxy ตอน deploy — ไม่ตั้งค่านี้ rate limit จะเห็น IP ของ proxy เป็น IP เดียวกันหมด
  if (env.isProduction) app.set('trust proxy', 1);

  // ไม่มีเหตุผลต้องประกาศว่าเป็น Express ให้คนไล่หาช่องโหว่ตามเวอร์ชัน
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use(API_BASE_PATH, router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
