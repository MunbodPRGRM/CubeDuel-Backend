import 'dotenv/config';
import path from 'node:path';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`ไม่พบตัวแปรสภาพแวดล้อม ${key} (ดู .env.example)`);
  return v;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

const accessSecret = required('JWT_ACCESS_SECRET');
const refreshSecret = required('JWT_REFRESH_SECRET');

// กันพลาดตอน deploy — ค่าตัวอย่างใน .env.example ห้ามหลุดขึ้น production
if (
  isProduction &&
  (accessSecret.startsWith('change-me') || refreshSecret.startsWith('change-me'))
) {
  throw new Error('JWT secret ยังเป็นค่าตัวอย่างอยู่ — ต้องเปลี่ยนก่อนรัน production');
}
if (accessSecret === refreshSecret) {
  throw new Error('JWT_ACCESS_SECRET กับ JWT_REFRESH_SECRET ต้องไม่เหมือนกัน');
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  /**
   * เปิดให้สร้างห้อง `competitive` ด้วยรหัสห้องเพื่อทดสอบการปรับ Elo ก่อนคิวจับคู่จะเสร็จ
   * (เฟส 5 ก้อนที่ 1 — ADR-038) บน production ปิดตายเสมอไม่ว่าจะตั้งค่าไว้ยังไง
   */
  allowTestCompetitiveRoom: !isProduction && process.env.ALLOW_TEST_COMPETITIVE_ROOM === '1',
  nodeEnv,
  isProduction,
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: required('DATABASE_URL'),
  /**
   * โฟลเดอร์เก็บไฟล์ที่ผู้ใช้อัปโหลด (รูปข่าว) — เสิร์ฟออกทาง `/uploads` (api-contract.md ข้อ 7)
   * ค่าเริ่มต้นอยู่ข้าง ๆ โค้ด เพราะ dev รันจาก `backend/` · ตอน deploy ให้ชี้ไป volume ที่ไม่หายตอน redeploy
   */
  uploadsDir: path.resolve(process.env.UPLOADS_DIR ?? 'uploads'),
  /** URL ของ frontend — ใช้ตอน redirect กลับจาก OAuth และลิงก์รีเซ็ตรหัสผ่าน */
  frontendUrl: process.env.FRONTEND_URL ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  jwt: {
    accessSecret,
    refreshSecret,
    /** ADR-010: access 15 นาที / refresh 30 วัน */
    accessExpires: process.env.JWT_ACCESS_EXPIRES ?? '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES ?? '30d',
  },
};
