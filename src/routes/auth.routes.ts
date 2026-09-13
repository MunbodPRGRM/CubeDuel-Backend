import { Router, type CookieOptions, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import {
  OAUTH_COOKIE_NAME,
  OAUTH_COOKIE_PATH,
  OAUTH_STATE_TTL_MS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from '../constants.js';
import { AppError, errors } from '../lib/errors.js';
import { parseDurationMs } from '../lib/jwt.js';
import {
  decodeFlowCookie,
  encodeFlowCookie,
  frontendUrlFor,
  loginErrorUrl,
  pkceChallenge,
  safeReturnTo,
  type OAuthErrorCode,
} from '../lib/oauth.js';
import { generateOpaqueToken } from '../lib/tokens.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { requireAuth, currentUser } from '../middleware/auth.js';
import {
  authLimiter,
  loginLimiter,
  oauthLimiter,
  registerLimiter,
  resetPasswordLimiter,
} from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import {
  changePasswordSchema,
  deleteAccountSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  type ResetPasswordInput,
} from '../schemas/auth.schema.js';
import * as authService from '../services/auth.service.js';
import * as oauth from '../services/oauth.service.js';
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

/** รีเซ็ตด้วย username + อีเมล ไม่มีลิงก์ ไม่มี `/forgot-password` (ADR-068 · ADR-069) */
authRouter.post(
  '/reset-password',
  resetPasswordLimiter,
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { username, email, newPassword } = req.body as ResetPasswordInput;
    await passwordReset.resetPassword(username, email, newPassword);
    // ทุกเซสชันถูกเพิกถอนแล้ว — ล้าง cookie ของเบราว์เซอร์นี้ด้วย ผู้ใช้ต้องเข้าสู่ระบบใหม่ (ADR-057 ข้อ 6)
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    res.json({ data: { passwordReset: true } });
  }),
);

// ---------------------------------------------------------------- เข้าสู่ระบบด้วย Google (ADR-058)

/**
 * `Lax` ไม่ใช่ `none`/`strict` — Google พากลับมาด้วย top-level GET ข้ามเว็บ
 * `strict` จะไม่ส่ง cookie นี้มาด้วย ส่วน `lax` ส่ง (ADR-058 ข้อ 2)
 */
function oauthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_MS,
  };
}

/** สอง endpoint นี้เป็นการเปิดหน้าเว็บ ไม่ใช่ fetch — ผิดพลาดแล้วพากลับหน้าเข้าสู่ระบบ ไม่ตอบ JSON */
function redirectToLoginError(res: Response, code: OAuthErrorCode) {
  res.redirect(302, loginErrorUrl(env.frontendUrl, code));
}

authRouter.get('/oauth/google', oauthLimiter, (req, res) => {
  if (!env.google) return redirectToLoginError(res, 'unavailable');

  const flow = {
    state: generateOpaqueToken(32),
    verifier: generateOpaqueToken(32),
    returnTo: safeReturnTo(req.query.returnTo),
  };
  res.cookie(OAUTH_COOKIE_NAME, encodeFlowCookie(flow), oauthCookieOptions());
  res.redirect(302, oauth.googleAuthUrl(flow.state, pkceChallenge(flow.verifier)));
});

authRouter.get(
  '/oauth/google/callback',
  oauthLimiter,
  asyncHandler(async (req, res) => {
    const flow = decodeFlowCookie(req.cookies?.[OAUTH_COOKIE_NAME]);
    // ใช้ได้รอบเดียว — ลบทิ้งทุกกรณี ไม่ว่าผลจะเป็นอะไร
    res.clearCookie(OAUTH_COOKIE_NAME, { path: OAUTH_COOKIE_PATH });

    if (!env.google) return redirectToLoginError(res, 'unavailable');

    const { code, state, error } = req.query;
    if (typeof error === 'string') {
      return redirectToLoginError(res, error === 'access_denied' ? 'cancelled' : 'failed');
    }
    // state ต้องตรงกับที่เราตั้งไว้ในเบราว์เซอร์นี้ — กันคนยิงลิงก์ callback ของตัวเองมาให้เหยื่อกด (login CSRF)
    if (!flow || typeof state !== 'string' || state !== flow.state || typeof code !== 'string' || !code) {
      return redirectToLoginError(res, 'invalid_state');
    }

    try {
      const profile = await oauth.exchangeGoogleCode(code, flow.verifier);
      const session = await oauth.signInWithGoogle(profile, deviceLabel(req));
      // ไม่มี token ใน URL — หน้าเว็บที่เปิดใหม่ขอ access token เองด้วย cookie นี้ (ADR-058 ข้อ 3)
      res.cookie(REFRESH_COOKIE_NAME, session.refreshToken, refreshCookieOptions());
      res.redirect(302, frontendUrlFor(env.frontendUrl, flow.returnTo));
    } catch (err) {
      if (err instanceof oauth.OAuthFlowError) return redirectToLoginError(res, err.code);
      if (err instanceof AppError && err.code === 'E_ACCOUNT_SUSPENDED') {
        return redirectToLoginError(res, 'suspended');
      }
      console.error('[oauth/google]', err);
      redirectToLoginError(res, 'failed');
    }
  }),
);
