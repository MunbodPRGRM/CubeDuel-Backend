import type { User } from '@prisma/client';

/** ผู้ใช้ที่ผ่าน requireAuth มาแล้ว — ห้ามเชื่อ userId ที่มากับ body/query */
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export {};
