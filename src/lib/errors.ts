/**
 * รหัส error + HTTP status ตาม docs/api-contract.md ข้อ 1
 * ทุก error ที่ตอบผู้ใช้ต้องผ่านคลาสนี้ เพื่อให้รูปแบบ response เหมือนกันทั้งระบบ
 */
export type ErrorCode =
  | 'E_VALIDATION'
  | 'E_UNAUTHENTICATED'
  | 'E_FORBIDDEN'
  | 'E_ACCOUNT_SUSPENDED'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_RATE_LIMITED'
  | 'E_INTERNAL';

const HTTP_STATUS: Record<ErrorCode, number> = {
  E_VALIDATION: 400,
  E_UNAUTHENTICATED: 401,
  E_FORBIDDEN: 403,
  E_ACCOUNT_SUSPENDED: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_RATE_LIMITED: 429,
  E_INTERNAL: 500,
};

/** ข้อความอธิบายรายฟิลด์ เช่น { email: 'รูปแบบอีเมลไม่ถูกต้อง' } */
export type ErrorFields = Record<string, string>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: ErrorFields;

  constructor(code: ErrorCode, message: string, fields?: ErrorFields) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.fields = fields;
  }
}

/**
 * ⚠️ ข้อความตั้งต้นของรหัสที่ **มีทั้งฝั่ง REST และฝั่ง socket** (`E_VALIDATION`,
 * `E_UNAUTHENTICATED`, `E_ACCOUNT_SUSPENDED`, `E_RATE_LIMITED`, `E_INTERNAL`)
 * ต้องตรงกับ `sockets/errors.ts` และกับคลังของ frontend เป๊ะ — ADR-054 ข้อ 2
 * · แก้ที่ไหนต้องไล่แก้ให้ครบทั้งสามที่ แล้วรัน `npm run verify:errors` ที่ฝั่ง frontend
 */
export const errors = {
  validation: (message = 'ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง', fields?: ErrorFields) =>
    new AppError('E_VALIDATION', message, fields),
  unauthenticated: (message = 'กรุณาเข้าสู่ระบบก่อนใช้งาน') =>
    new AppError('E_UNAUTHENTICATED', message),
  forbidden: (message = 'ไม่มีสิทธิ์เข้าถึงส่วนนี้') => new AppError('E_FORBIDDEN', message),
  accountSuspended: (message = 'บัญชีนี้ถูกระงับการใช้งาน') =>
    new AppError('E_ACCOUNT_SUSPENDED', message),
  notFound: (message = 'ไม่พบข้อมูลที่ต้องการ') => new AppError('E_NOT_FOUND', message),
  conflict: (message = 'ข้อมูลนี้ถูกใช้ไปแล้ว', fields?: ErrorFields) =>
    new AppError('E_CONFLICT', message, fields),
  rateLimited: (message = 'ใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่') =>
    new AppError('E_RATE_LIMITED', message),
  internal: (message = 'เกิดข้อผิดพลาดฝั่งระบบ กรุณาลองใหม่อีกครั้ง') =>
    new AppError('E_INTERNAL', message),
};
