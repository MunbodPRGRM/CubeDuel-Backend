import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';

/**
 * ตรวจ body ด้วย Zod ที่ชั้น middleware ชั้นเดียว (api-contract.md ข้อ 11)
 * ผ่านแล้วเขียนค่าที่ผ่าน parse กลับลง req.body — controller จะได้ข้อมูลที่ trim/แปลงชนิดแล้ว
 */
export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(result.error);
    req.body = result.data as z.infer<T>;
    next();
  };
}

/**
 * ตรวจ query string — Express 4 เขียนทับ `req.query` ตรง ๆ ไม่ได้
 * จึงเก็บค่าที่ผ่าน parse ไว้ที่ `req.validatedQuery` แทน (ดู src/types/express.d.ts)
 */
export function validateQuery<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) return next(result.error);
    req.validatedQuery = result.data;
    next();
  };
}

/** อ่านค่าที่ validateQuery เก็บไว้ แบบมี type */
export function queryOf<T extends ZodTypeAny>(req: { validatedQuery?: unknown }): z.infer<T> {
  return req.validatedQuery as z.infer<T>;
}
