/**
 * ตรวจ JWT ตอน handshake (`docs/socket-events.md` ข้อ 2)
 *
 * อ่านแถว `User` จาก DB ทุกครั้งเหมือน `requireAuth` ของ REST — บัญชีที่แอดมินเพิ่งระงับ
 * ต้องต่อ socket ไม่ได้ทันที ไม่ใช่รอ access token หมดอายุอีก 15 นาที (ADR-023 · ADR-034 ข้อ 7)
 *
 * **token หมดอายุระหว่างที่ต่ออยู่ไม่ตัดสาย** — connection ของ socket อยู่ยาวข้ามอายุ token
 * (15 นาที) เป็นเรื่องปกติ ถ้าตัดกลางแมตช์ผู้เล่นจะโดน DNF ด้วยเรื่องที่ไม่เกี่ยวกับเกม
 */
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';
import { assertUsable } from '../services/auth.service.js';
import { USER_ROLE_TO_API } from '../types/api.js';
import { SocketError, socketErrors } from './errors.js';
import type { TypedSocket } from './ack.js';

/** แปลง error ของ REST เป็นของ socket — `connect_error` ฝั่ง client อ่าน `err.data.code` */
function toConnectError(error: unknown): Error & { data: { code: string } } {
  let socketError: SocketError;
  if (error instanceof SocketError) {
    socketError = error;
  } else if (error instanceof AppError && error.code === 'E_ACCOUNT_SUSPENDED') {
    socketError = socketErrors.accountSuspended(error.message);
  } else if (error instanceof AppError && error.code === 'E_UNAUTHENTICATED') {
    socketError = socketErrors.unauthenticated(error.message);
  } else {
    console.error('[socket] handshake', error);
    socketError = socketErrors.internal();
  }

  return Object.assign(new Error(socketError.message), {
    data: { code: socketError.code, message: socketError.message },
  });
}

export async function authenticateSocket(socket: TypedSocket): Promise<void> {
  const raw = socket.handshake.auth?.token;
  const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) throw socketErrors.unauthenticated('ต้องแนบ access token มากับ handshake');

  const payload = verifyAccessToken(token);
  const user = await prisma.user.findUnique({ where: { userId: payload.sub } });
  if (!user) throw socketErrors.unauthenticated('ไม่พบบัญชีผู้ใช้');

  const usable = await assertUsable(user);
  socket.data.userId = usable.userId;
  socket.data.username = usable.username;
  socket.data.nickname = usable.nickname;
  socket.data.role = USER_ROLE_TO_API[usable.role];
  socket.data.rttMs = null;
  socket.data.roomId = null;
  socket.data.seat = null;
}

/** middleware ที่เอาไปใส่ `io.use()` */
export function authMiddleware(socket: TypedSocket, next: (err?: Error) => void): void {
  authenticateSocket(socket)
    .then(() => next())
    .catch((error: unknown) => next(toConnectError(error)));
}
