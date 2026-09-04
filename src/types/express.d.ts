import type { User } from '@prisma/client';

/** ผู้ใช้ที่ผ่าน requireAuth มาแล้ว — ห้ามเชื่อ userId ที่มากับ body/query */
declare global {
  namespace Express {
    interface Request {
      user?: User;
      /** ค่าที่ผ่าน validateQuery แล้ว — Express 4 เขียนทับ req.query ไม่ได้ */
      validatedQuery?: unknown;
    }
  }
}

export {};
