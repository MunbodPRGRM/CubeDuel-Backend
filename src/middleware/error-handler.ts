import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError, errors, type ErrorFields } from '../lib/errors.js';
import { env } from '../config/env.js';

/** ไม่มี route ไหนรับ → 404 ในรูปแบบ envelope เดียวกับ error อื่น */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(errors.notFound(`ไม่พบ endpoint ${req.method} ${req.originalUrl}`));
};

function fromZod(err: ZodError): AppError {
  const fields: ErrorFields = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    // เก็บข้อความแรกของแต่ละฟิลด์ไว้พอ ผู้ใช้อ่านทีละข้อ
    if (!(key in fields)) fields[key] = issue.message;
  }
  // ข้อความรวมใช้ของตั้งต้น — รายละเอียดที่ผู้ใช้ต้องแก้จริงอยู่ใน `fields` รายช่องอยู่แล้ว
  return errors.validation(undefined, fields);
}

/**
 * error ของ `express.json()` (body-parser) — มี `type` กับ `status` 4xx ติดมาด้วย
 *
 * เดิมตกไปเป็น 500 `E_INTERNAL` พร้อม stack ใน log ทั้งที่เป็นความผิดของ request ไม่ใช่บั๊กของเรา
 * ใครก็ยิง JSON พัง ๆ ให้ log เต็มได้ (ADR-055 ข้อ 1) · ใช้ `E_VALIDATION` ตัวเดียว
 * ไม่เพิ่ม 413 เพราะตารางรหัสใน api-contract.md ผูกรหัสกับ status ไว้ตายตัว
 */
function fromBodyParser(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null) return null;
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return null;
  if (status < 400 || status >= 500) return null;

  if (type === 'entity.too.large') return errors.validation('ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป');
  if (type === 'entity.parse.failed') return errors.validation('รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง');
  return errors.validation('อ่านข้อมูลที่ส่งมาไม่ได้');
}

/**
 * error handler กลาง — ทุก error ออกจากที่นี่ที่เดียว
 * รูปแบบ: { error: { code, message, fields? } } ตาม api-contract.md ข้อ 1
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = fromZod(err);
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    appError = errors.conflict('ข้อมูลนี้ถูกใช้ไปแล้ว');
  } else {
    const bodyError = fromBodyParser(err);
    if (bodyError) {
      appError = bodyError;
    } else {
      // ไม่รู้จัก = บั๊กของเรา ห้ามส่งรายละเอียดออกไปให้ผู้ใช้
      console.error('[error]', err);
      appError = errors.internal();
    }
  }

  const body: Record<string, unknown> = { code: appError.code, message: appError.message };
  if (appError.fields) body.fields = appError.fields;
  if (!env.isProduction && appError.code === 'E_INTERNAL' && err instanceof Error) {
    body.debug = err.message;
  }

  res.status(appError.status).json({ error: body });
};
