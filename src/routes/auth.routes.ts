import { Router, type CookieOptions, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '../constants.js';
import { errors } from '../lib/errors.js';
import { parseDurationMs } from '../lib/jwt.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { requireAuth, currentUser } from '../middleware/auth.js';
import {
  authLimiter,
  forgotPasswordLimiter,
  loginLimiter,
  registerLimiter,
} from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import {
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from '../schemas/auth.schema.js';
import * as authService from '../services/auth.service.js';
import * as passwordReset from '../services/password-reset.service.js';
import type { AuthSessionDto } from '../types/api.js';

export const authRouter = Router();

/**
 * refresh token เดินทาง 2 ทาง (ADR-023):
 *   - เว็บ: httpOnly cookie — JavaScript อ่านไม่ได้ ทน XSS (ADR-010)
 *   - Capacitor: ค่าใน body ของ response เอาไปเก็บใน secure storage เอง (คุกกี้ใช้ไม่ได้ในแอป)
 */
function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    // production คนละโดเมนกัน (เว็บ ↔ api) ต้อง none, ตอน dev เป็น localhost คนละพอร์ต lax พอ
    sameSite: env.isProduction ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: parseDurationMs(env.jwt.refreshExpires),
  };
}

function sendSession(res: Response, session: AuthSessionDto, status = 200) {
  res.cookie(REFRESH_COOKIE_NAME, session.refreshToken, refreshCookieOptions());
  res.status(status).json({ data: session });
}

/** หา refresh token จาก cookie ก่อน แล้วค่อยดู body (Capacitor) */
function readRefreshToken(req: Request): string | undefined {
  const fromCookie = req.cookies?.[REFRESH_COOKIE_NAME];
  const fromBody = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
  return fromCookie || fromBody || undefined;
}

/** ใช้เป็น device_label ของแถว RefreshToken — ช่วยให้ผู้ใช้ดูออกว่าเซสชันไหนคืออุปกรณ์อะไร */
function deviceLabel(req: Request): string | undefined {
  return req.header('user-agent') ?? undefined;
}

authRouter.post(
  '/register',
  registerLimiter,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const session = await authService.register(req.body, deviceLabel(req));
    sendSession(res, session, 201);
  }),
);

authRouter.post(
  '/login',
  loginLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const session = await authService.login(req.body, deviceLabel(req));
    sendSession(res, session);
  }),
);

authRouter.post(
  '/refresh',
  authLimiter,
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const token = readRefreshToken(req);
    if (!token) throw errors.unauthenticated('ไม่พบ refresh token');
    const session = await authService.refreshSession(token, deviceLabel(req));
    sendSession(res, session);
  }),
);

authRouter.post(
  '/logout',
  authLimiter,
  requireAuth,
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    await authService.logout(readRefreshToken(req));
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    res.json({ data: { loggedOut: true } });
  }),
);

/** ออกจากระบบทุกอุปกรณ์ — เพิกถอน refresh token ทั้งหมด (database-schema.md ตารางที่ 4) */
authRouter.post(
  '/logout-all',
  authLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.logoutAllDevices(currentUser(req).userId);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    res.json({ data: { loggedOut: true } });
  }),
);

authRouter.post(
  '/change-password',
  authLimiter,
  requireAuth,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    await authService.changePassword(currentUser(req).userId, currentPassword, newPassword);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    // เปลี่ยนรหัสผ่านแล้วทุกเซสชันถูกเพิกถอน ผู้ใช้ต้องเข้าสู่ระบบใหม่
    res.json({ data: { passwordChanged: true } });
  }),
);

authRouter.delete(
  '/account',
  authLimiter,
  requireAuth,
  validateBody(deleteAccountSchema),
  asyncHandler(async (req, res) => {
    await authService.deleteAccount(currentUser(req).userId, req.body.password);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    res.json({ data: { deleted: true } });
  }),
);

/**
 * ขอลิงก์รีเซ็ตรหัสผ่าน — **ตอบก่อน แล้วค่อยหาบัญชีกับส่งอีเมล** (ADR-057 ข้อ 1)
 * ถ้ารอส่งเสร็จ อีเมลที่มีบัญชีจะตอบช้ากว่าเห็น ๆ = บอกคนนอกว่าอีเมลไหนสมัครไว้
 */
authRouter.post(
  '/forgot-password',
  forgotPasswordLimiter,
  validateBody(forgotPasswordSchema),
  (req, res) => {
    const { email } = req.body as ForgotPasswordInput;
    res.json({ data: { sent: true } });
    void passwordReset
      .requestPasswordReset(email)
      .catch((err: unknown) => console.error('[forgot-password]', err));
  },
);

authRouter.post(
  '/reset-password',
  authLimiter,
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body as ResetPasswordInput;
    await passwordReset.resetPassword(token, newPassword);
    // ทุกเซสชันถูกเพิกถอนแล้ว — ล้าง cookie ของเบราว์เซอร์นี้ด้วย ผู้ใช้ต้องเข้าสู่ระบบใหม่ (ADR-057 ข้อ 6)
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    res.json({ data: { passwordReset: true } });
  }),
);

// TODO(เฟส 2): GET /oauth/:provider + callback
