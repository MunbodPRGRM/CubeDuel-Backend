import 'dotenv/config';

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
  nodeEnv,
  isProduction,
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: required('DATABASE_URL'),
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
