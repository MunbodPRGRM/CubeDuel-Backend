import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 ไม่จับ error จาก async handler ให้เอง — ถ้าไม่ห่อ จะกลายเป็น unhandled rejection
 * (Express 5 ทำให้เอง ถ้าอัปเกรดเมื่อไหร่ตัวนี้ลบได้)
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
