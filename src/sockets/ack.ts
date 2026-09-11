/**
 * ตัวห่อ handler ของทุก event — ทำสามอย่างเหมือนกันหมด (ADR-034 ข้อ 5):
 *   1. เช็ค rate limit ของ socket นั้น
 *   2. ตรวจ payload ด้วย Zod → ผิดรูปตอบ `E_VALIDATION`
 *   3. เรียก handler แล้วแปลงผล/ข้อผิดพลาดเป็น ack `{ ok, data | error }`
 *
 * client ที่ไม่แนบ ack callback มา (fire-and-forget เช่น `solve:move`) จะได้ error
 * ผ่าน event `error` แทน — ตาม `docs/socket-events.md` ข้อ 7
 */
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { env } from '../config/env.js';
import { SocketError, socketErrors } from './errors.js';
import { SocketRateLimiter } from './rate-limit.js';
import type {
  AckError,
  AckFn,
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from './types.js';

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>;
export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>;

const limiters = new WeakMap<TypedSocket, SocketRateLimiter>();

function limiterOf(socket: TypedSocket): SocketRateLimiter {
  let limiter = limiters.get(socket);
  if (!limiter) {
    limiter = new SocketRateLimiter();
    limiters.set(socket, limiter);
  }
  return limiter;
}

/** ข้อความแรกที่ Zod ฟ้อง — พอสำหรับ socket (ไม่มีฟอร์มให้ไฮไลต์รายฟิลด์เหมือน REST) */
function fromZod(error: ZodError): SocketError {
  const issue = error.issues[0];
  const path = issue?.path.join('.');
  return socketErrors.validation(issue ? `${path ? `${path}: ` : ''}${issue.message}` : undefined);
}

function toAckError(error: unknown, event: string): AckError {
  if (error instanceof SocketError) return { code: error.code, message: error.message };
  if (error instanceof ZodError) {
    const converted = fromZod(error);
    return { code: converted.code, message: converted.message };
  }
  // ไม่รู้จัก = บั๊กของเรา ห้ามส่งรายละเอียดจริงออกไปให้ผู้ใช้
  console.error(`[socket] ${event}`, error);
  const internal = socketErrors.internal();
  return {
    code: internal.code,
    message: env.isProduction || !(error instanceof Error) ? internal.message : error.message,
  };
}

export type SocketHandler<P, R> = (socket: TypedSocket, payload: P) => Promise<R> | R;

export interface OnOptions {
  /**
   * ล้มแล้ว **ทิ้งเงียบ** ไม่ emit event `error` (ถ้า client แนบ ack มาก็ยังตอบตามปกติ)
   * ใช้กับ event ที่ส่งถี่และหายไปหนึ่งครั้งไม่มีผล — `solve:camera` (ADR-062 ข้อ 2)
   * ข้อผิดพลาดที่ไม่รู้จักยัง log ฝั่ง server เหมือนเดิม
   */
  quiet?: boolean;
}

/**
 * ผูก handler เข้ากับ event หนึ่งตัว
 * (ต้อง cast ตอน `socket.on` เพราะ type ของ Socket.IO บังคับ signature ของแต่ละ event ตายตัว)
 */
export function on<S extends ZodTypeAny, R>(
  socket: TypedSocket,
  event: keyof ClientToServerEvents & string,
  schema: S,
  handler: SocketHandler<z.infer<S>, R>,
  options: OnOptions = {},
): void {
  const listener = (rawPayload: unknown, rawAck?: unknown) => {
    const respond = typeof rawAck === 'function' ? (rawAck as AckFn<R>) : undefined;

    const fail = (error: unknown) => {
      const ackError = toAckError(error, event);
      if (!respond && options.quiet) return;
      if (respond) respond({ ok: false, error: ackError });
      else socket.emit('error', ackError);
    };

    try {
      if (!limiterOf(socket).allow(event)) throw socketErrors.rateLimited();
      const payload = schema.parse(rawPayload ?? {}) as z.infer<S>;
      Promise.resolve(handler(socket, payload))
        .then((data) => respond?.({ ok: true, data }))
        .catch(fail);
    } catch (error) {
      fail(error);
    }
  };

  socket.on(event as never, listener as never);
}

/** เรียกตอน disconnect — ทิ้งตัวนับ rate limit ของ socket ที่ตายแล้ว */
export function disposeLimiter(socket: TypedSocket): void {
  limiters.get(socket)?.clear();
  limiters.delete(socket);
}
