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

/**
 * ส่งอีเมล (ADR-056) — `console` = พิมพ์ลง log แทนการส่งจริง ใช้ตอน dev ได้โดยไม่ต้องมีบัญชีอะไร
 * production ต้องเป็น `smtp` และตั้ง SMTP ครบ ไม่งั้นสตาร์ตไม่ขึ้น
 * (เงียบ ๆ ไม่ส่งอีเมลรีเซ็ตรหัสผ่านบน production แย่กว่าล้มตั้งแต่สตาร์ต)
 */
function emailTransport(): 'smtp' | 'console' {
  const value = process.env.EMAIL_TRANSPORT || (isProduction ? 'smtp' : 'console');
  if (value !== 'smtp' && value !== 'console') {
    throw new Error(`EMAIL_TRANSPORT ต้องเป็น smtp หรือ console (ได้ "${value}")`);
  }
  if (isProduction && value !== 'smtp') {
    throw new Error('production ต้องตั้ง EMAIL_TRANSPORT=smtp — โหมด console ไม่ได้ส่งอีเมลจริง');
  }
  return value;
}

const mailTransport = emailTransport();

function smtpConfig() {
  const port = Number(process.env.SMTP_PORT || 465);
  if (!Number.isInteger(port)) throw new Error('SMTP_PORT ต้องเป็นตัวเลข');
  return {
    host: required('SMTP_HOST'),
    port,
    user: required('SMTP_USER'),
    /** Gmail = App Password 16 ตัว ไม่ใช่รหัสผ่านจริงของบัญชี (ADR-056 ข้อ 2) */
    pass: required('SMTP_PASS'),
  };
}

const smtp = mailTransport === 'smtp' ? smtpConfig() : null;

const port = Number(process.env.PORT ?? 4000);

/**
 * เข้าสู่ระบบด้วย Google (ADR-058) — ไม่ตั้ง client id/secret = ปิดฟีเจอร์นี้ ไม่ใช่สตาร์ตไม่ขึ้น
 * (ปุ่มบนหน้าเว็บยังอยู่ กดแล้วกลับมาพร้อม `oauth_error=unavailable`) เพราะเป็นทางเสริมของการเข้าสู่ระบบ
 * `callbackUrl` ต้องตรงกับ Authorized redirect URI ใน Google Cloud Console ทุกตัวอักษร
 */
function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    callbackUrl:
      process.env.GOOGLE_CALLBACK_URL?.trim() ||
      `http://localhost:${port}/api/v1/auth/oauth/google/callback`,
  };
}

export const env = {
  port,
  /**
   * เปิดให้สร้างห้อง `competitive` ด้วยรหัสห้องเพื่อทดสอบการปรับ Elo ก่อนคิวจับคู่จะเสร็จ
   * (เฟส 5 ก้อนที่ 1 — ADR-038) บน production ปิดตายเสมอไม่ว่าจะตั้งค่าไว้ยังไง
   */
  allowTestCompetitiveRoom: !isProduction && process.env.ALLOW_TEST_COMPETITIVE_ROOM === '1',
  nodeEnv,
  isProduction,
  /**
   * ปิดงานเบื้องหลังทั้งหมด (`src/jobs/`) — ใช้ตอนรันสโมคเทสของงานเบื้องหลังเอง
   * จะได้ไม่มีตัวจับเวลามาแย่งทำงานที่สคริปต์กำลังจะตรวจ
   */
  disableMaintenanceJobs: process.env.DISABLE_MAINTENANCE_JOBS === 'true',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: required('DATABASE_URL'),
  /**
   * โฟลเดอร์เก็บไฟล์ที่ผู้ใช้อัปโหลด (รูปข่าว) — เสิร์ฟออกทาง `/uploads` (api-contract.md ข้อ 7)
   * ค่าเริ่มต้นอยู่ข้าง ๆ โค้ด เพราะ dev รันจาก `backend/` · ตอน deploy ให้ชี้ไป volume ที่ไม่หายตอน redeploy
   */
  uploadsDir: path.resolve(process.env.UPLOADS_DIR ?? 'uploads'),
  /** URL ของ frontend — ใช้ตอน redirect กลับจาก OAuth และลิงก์รีเซ็ตรหัสผ่าน */
  frontendUrl: process.env.FRONTEND_URL ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  /** ส่งอีเมล (ADR-056) — ใช้ผ่าน `lib/mailer.ts` เท่านั้น */
  mail: {
    transport: mailTransport,
    /** `null` เมื่อ `transport = 'console'` */
    smtp,
    from:
      process.env.MAIL_FROM ||
      (smtp ? `CubeDuel <${smtp.user}>` : 'CubeDuel <noreply@cubeduel.local>'),
  },
  /** `null` = ไม่ได้ตั้งค่า → ปิดการเข้าสู่ระบบด้วย Google */
  google: googleConfig(),
  jwt: {
    accessSecret,
    refreshSecret,
    /** ADR-010: access 15 นาที / refresh 30 วัน */
    accessExpires: process.env.JWT_ACCESS_EXPIRES ?? '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES ?? '30d',
  },
};
