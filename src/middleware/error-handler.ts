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
  return errors.validation('ข้อมูลที่ส่งมาไม่ผ่านการตรวจสอบ', fields);
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
    // ไม่รู้จัก = บั๊กของเรา ห้ามส่งรายละเอียดออกไปให้ผู้ใช้
    console.error('[error]', err);
    appError = errors.internal();
  }

  const body: Record<string, unknown> = { code: appError.code, message: appError.message };
  if (appError.fields) body.fields = appError.fields;
  if (!env.isProduction && appError.code === 'E_INTERNAL' && err instanceof Error) {
    body.debug = err.message;
  }

  res.status(appError.status).json({ error: body });
};
