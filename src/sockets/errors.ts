/**
 * รหัส error ของฝั่ง Socket.IO — คนละชุดกับของ REST (`lib/errors.ts`)
 *
 * ที่มา: `docs/socket-events.md` ข้อ 1 "รหัส error มาตรฐาน"
 * แยกคลาสจาก `AppError` เพราะ socket ไม่มี HTTP status และรหัสไม่ทับกันเลย (ADR-034 ข้อ 5)
 */
export type SocketErrorCode =
  | 'E_VALIDATION'
  | 'E_UNAUTHENTICATED'
  | 'E_ROOM_NOT_FOUND'
  | 'E_ROOM_FULL'
  | 'E_NOT_HOST'
  | 'E_INVALID_STATE'
  | 'E_MOVE_DURING_INSPECTION'
  | 'E_INVALID_MOVE'
  | 'E_SEQ_MISMATCH'
  | 'E_NOT_SOLVED'
  | 'E_ALREADY_IN_QUEUE'
  | 'E_ACCOUNT_SUSPENDED'
  | 'E_RATE_LIMITED'
  | 'E_INTERNAL';

export class SocketError extends Error {
  readonly code: SocketErrorCode;

  constructor(code: SocketErrorCode, message: string) {
    super(message);
    this.name = 'SocketError';
    this.code = code;
  }
}

/**
 * ⚠️ รหัสที่มีทั้งฝั่ง REST และฝั่งนี้ต้องพูดเหมือน `lib/errors.ts` เป๊ะ — ADR-054 ข้อ 2
 */
export const socketErrors = {
  validation: (message = 'ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง') =>
    new SocketError('E_VALIDATION', message),
  unauthenticated: (message = 'กรุณาเข้าสู่ระบบก่อนใช้งาน') =>
    new SocketError('E_UNAUTHENTICATED', message),
  roomNotFound: (message = 'ไม่พบห้องนี้ อาจถูกยุบไปแล้วหรือรหัสห้องผิด') =>
    new SocketError('E_ROOM_NOT_FOUND', message),
  roomFull: (message = 'ห้องนี้เต็มแล้ว') => new SocketError('E_ROOM_FULL', message),
  notHost: (message = 'เฉพาะหัวห้องเท่านั้นที่สั่งได้') => new SocketError('E_NOT_HOST', message),
  invalidState: (message = 'สั่งไม่ได้ในจังหวะนี้') => new SocketError('E_INVALID_STATE', message),
  moveDuringInspection: (message = 'หมุนคิวบ์ระหว่างช่วงตรวจสอบไม่ได้') =>
    new SocketError('E_MOVE_DURING_INSPECTION', message),
  invalidMove: (message = 'ท่าหมุนนี้ใช้กับรูบิคประเภทนี้ไม่ได้') =>
    new SocketError('E_INVALID_MOVE', message),
  seqMismatch: (message = 'ลำดับท่าหมุนไม่ต่อเนื่อง กรุณาลองใหม่') =>
    new SocketError('E_SEQ_MISMATCH', message),
  notSolved: (message = 'คิวบ์ยังไม่อยู่ในสถานะแก้เสร็จ') =>
    new SocketError('E_NOT_SOLVED', message),
  alreadyInQueue: (message = 'อยู่ในคิวจับคู่อยู่แล้ว') =>
    new SocketError('E_ALREADY_IN_QUEUE', message),
  accountSuspended: (message = 'บัญชีนี้ถูกระงับการใช้งาน') =>
    new SocketError('E_ACCOUNT_SUSPENDED', message),
  rateLimited: (message = 'ใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่') =>
    new SocketError('E_RATE_LIMITED', message),
  internal: (message = 'เกิดข้อผิดพลาดฝั่งระบบ กรุณาลองใหม่อีกครั้ง') =>
    new SocketError('E_INTERNAL', message),
};
