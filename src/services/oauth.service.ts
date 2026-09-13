import { randomInt } from 'node:crypto';
import { OAuthProvider, Prisma, type User } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import {
  facebookAppSecretProof,
  readFacebookProfile,
  readGoogleIdToken,
  usernameBaseFromEmail,
  type OAuthErrorCode,
  type OAuthProfile,
} from '../lib/oauth.js';
import type { AuthSessionDto } from '../types/api.js';
import {
  assertUsable,
  createInitialRatings,
  issueSession,
  revokeAllRefreshTokens,
} from './auth.service.js';

/**
 * เข้าสู่ระบบด้วย Google (ADR-058) และ Facebook (ADR-070) — Authorization Code + PKCE เขียนเองด้วย `fetch`
 * กฎการหา/ผูก/สร้างบัญชี: docs/database-schema.md ตารางที่ 2 + ADR-058 ข้อ 4 — **ตัวเดียวกันทั้งสอง provider**
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/**
 * เวอร์ชัน Graph API — มีที่เดียว · Meta ปลดเวอร์ชันเก่าประมาณ 2 ปีหลังออก ต้องขยับตาม (ADR-070 ข้อ 2)
 */
const FACEBOOK_GRAPH_VERSION = 'v25.0';
const FACEBOOK_AUTH_URL = `https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`;
const FACEBOOK_TOKEN_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`;
const FACEBOOK_ME_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me`;
/** provider ไม่ตอบภายในเวลานี้ = ถือว่าล้ม ไม่ปล่อยให้ผู้ใช้ค้างหน้าขาวไปเรื่อย ๆ */
const PROVIDER_TIMEOUT_MS = 10_000;

/** ความผิดพลาดที่รู้ความหมาย → กลายเป็น `?oauth_error=<code>` ตรง ๆ (ที่เหลือเป็น `failed`) */
export class OAuthFlowError extends Error {
  readonly code: OAuthErrorCode;

  constructor(code: OAuthErrorCode, message: string = code) {
    super(message);
    this.name = 'OAuthFlowError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- Google

function googleConfig() {
  if (!env.google) throw new OAuthFlowError('unavailable');
  return env.google;
}

/** URL หน้าเลือกบัญชีของ Google */
export function googleAuthUrl(state: string, codeChallenge: string): string {
  const google = googleConfig();
  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: google.callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // เครื่องที่ใช้ร่วมกันต้องเลือกบัญชีได้ทุกครั้ง ไม่ใช่เข้าบัญชีที่ค้างอยู่ในเบราว์เซอร์เงียบ ๆ
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** แลก `code` เป็น id_token แล้วอ่านข้อมูลผู้ใช้ออกมา */
export async function exchangeGoogleCode(code: string, codeVerifier: string): Promise<OAuthProfile> {
  const google = googleConfig();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: google.clientId,
      client_secret: google.clientSecret,
      redirect_uri: google.callbackUrl,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  const body = (await res.json().catch(() => null)) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!res.ok || !body?.id_token) {
    // ไม่ใส่ code / secret ลง log — มีแค่สิ่งที่ Google ตอบกลับมา
    throw new Error(
      `แลก code กับ Google ไม่ผ่าน: HTTP ${res.status} ${body?.error ?? ''} ${body?.error_description ?? ''}`.trim(),
    );
  }
  return readGoogleIdToken(body.id_token, google.clientId);
}

// ---------------------------------------------------------------- Facebook

function facebookConfig() {
  if (!env.facebook) throw new OAuthFlowError('unavailable');
  return env.facebook;
}

/** Graph API ตอบ error เป็น `{ error: { message, type, code } }` */
function graphErrorText(body: unknown): string {
  const error = (body as { error?: { message?: string; type?: string; code?: number } } | null)?.error;
  return error ? `${error.type ?? ''} ${error.code ?? ''} ${error.message ?? ''}`.trim() : '';
}

/**
 * URL หน้าขอสิทธิ์ของ Facebook (ADR-070 ข้อ 2)
 * · PKCE: เอกสาร manual flow ไม่ได้เขียนถึง แต่ส่งไปด้วย — รองรับก็ได้ชั้นเพิ่ม ไม่รองรับก็ถูกข้าม
 * · `auth_type=rerequest` — คนที่เคยกดไม่ให้อีเมลจะถูกถามใหม่ ไม่งั้นติด `email_missing` ถาวร
 */
export function facebookAuthUrl(state: string, codeChallenge: string): string {
  const facebook = facebookConfig();
  const params = new URLSearchParams({
    client_id: facebook.clientId,
    redirect_uri: facebook.callbackUrl,
    response_type: 'code',
    scope: 'public_profile,email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    auth_type: 'rerequest',
  });
  return `${FACEBOOK_AUTH_URL}?${params.toString()}`;
}

/** แลก `code` เป็น access_token แล้วถาม `/me` — Facebook ไม่มี id_token ในทางเว็บ */
export async function exchangeFacebookCode(code: string, codeVerifier: string): Promise<OAuthProfile> {
  const facebook = facebookConfig();
  const tokenParams = new URLSearchParams({
    client_id: facebook.clientId,
    client_secret: facebook.clientSecret,
    redirect_uri: facebook.callbackUrl,
    code,
    code_verifier: codeVerifier,
  });
  const tokenRes = await fetch(`${FACEBOOK_TOKEN_URL}?${tokenParams.toString()}`, {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const tokenBody = (await tokenRes.json().catch(() => null)) as { access_token?: string } | null;
  if (!tokenRes.ok || typeof tokenBody?.access_token !== 'string' || !tokenBody.access_token) {
    // ไม่ใส่ URL ลง log — มี code กับ app secret อยู่ใน query
    throw new Error(`แลก code กับ Facebook ไม่ผ่าน: HTTP ${tokenRes.status} ${graphErrorText(tokenBody)}`.trim());
  }

  const accessToken = tokenBody.access_token;
  const meParams = new URLSearchParams({
    fields: 'id,name,email',
    appsecret_proof: facebookAppSecretProof(accessToken, facebook.clientSecret),
  });
  const meRes = await fetch(`${FACEBOOK_ME_URL}?${meParams.toString()}`, {
    // token อยู่ใน header ไม่ใช่ query — ไม่ไปโผล่ใน log ของใครระหว่างทาง
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const meBody = await meRes.json().catch(() => null);
  if (!meRes.ok) {
    throw new Error(`อ่านข้อมูลผู้ใช้จาก Facebook ไม่ผ่าน: HTTP ${meRes.status} ${graphErrorText(meBody)}`.trim());
  }
  return readFacebookProfile(meBody);
}

// ---------------------------------------------------------------- หา / ผูก / สร้างบัญชี

/** ตัดตามจำนวนตัวอักษรจริง ไม่ใช่ UTF-16 — อีโมจิในชื่อจะได้ไม่ขาดครึ่งตัว */
function nicknameFrom(name: string | null): string | null {
  if (!name) return null;
  return Array.from(name).slice(0, 50).join('').trim() || null;
}

/** username ที่ยังว่าง: ของตั้งต้น → ต่อเลขสุ่ม 4 หลัก 5 รอบ → เลขสุ่ม 8 หลัก (ADR-058 ข้อ 5) */
async function pickUsername(base: string): Promise<string> {
  const candidates = [base, ...Array.from({ length: 5 }, () => `${base}_${randomInt(1_000, 10_000)}`)];
  for (const username of candidates) {
    const taken = await prisma.user.findUnique({ where: { username }, select: { userId: true } });
    if (!taken) return username;
  }
  return `${base}_${randomInt(10_000_000, 100_000_000)}`;
}

async function resolveOAuthUser(provider: OAuthProvider, profile: OAuthProfile): Promise<User> {
  // 1. เคยผูกไว้แล้ว → เข้าบัญชีนั้น (ไม่ต้องใช้อีเมล — Facebook ที่ไม่มีอีเมลก็เข้าได้ ADR-070 ข้อ 4)
  const linked = await prisma.oAuthAccount.findUnique({
    where: { provider_providerUserId: { provider, providerUserId: profile.sub } },
    include: { user: true },
  });
  if (linked) return assertUsable(linked.user);

  // 2. จะผูกหรือสร้างบัญชีจากอีเมล อีเมลต้องมีและต้องเป็นของเขาจริง
  if (!profile.email) throw new OAuthFlowError('email_missing');
  if (!profile.emailVerified) throw new OAuthFlowError('email_unverified');
  // `lib/oauth.ts` ทำตัวพิมพ์เล็กให้แล้ว — ทำซ้ำตรงนี้เพราะการหาบัญชีเดิมพังเงียบ ๆ ถ้าพลาด
  const email = profile.email.trim().toLowerCase();
  if (email.length > 100) throw new Error(`อีเมลจาก ${provider} ยาวเกิน 100 ตัว เก็บลง User.email ไม่ได้`);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && !existing.deletedAt) {
    // ตรวจก่อนผูก — ไม่สร้างแถว OAuthAccount ให้บัญชีที่ถูกระงับ
    const usable = await assertUsable(existing);
    return prisma.$transaction(async (tx) => {
      await tx.oAuthAccount.create({
        data: { userId: usable.userId, provider, providerUserId: profile.sub },
      });
      if (!usable.passwordHash) return usable;

      // pre-account takeover (ADR-058 ข้อ 4): ตอนสมัครด้วยรหัสผ่านเราไม่เคยยืนยันอีเมล
      // รหัสผ่านเดิมอาจเป็นของคนที่สมัครดักไว้ → ล้างทิ้งพร้อมเตะทุกเซสชันออก
      await revokeAllRefreshTokens(usable.userId, tx);
      return tx.user.update({ where: { userId: usable.userId }, data: { passwordHash: null } });
    });
  }

  // 3. ผู้ใช้ใหม่ — User + Rating 4 แถว + OAuthAccount ในทรานแซกชันเดียว
  const username = await pickUsername(usernameBaseFromEmail(email));
  return prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username,
        email,
        passwordHash: null,
        nickname: nicknameFrom(profile.name),
      },
    });
    await createInitialRatings(tx, created.userId);
    await tx.oAuthAccount.create({
      data: { userId: created.userId, provider, providerUserId: profile.sub },
    });
    return created;
  });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function signInWithOAuth(
  provider: OAuthProvider,
  profile: OAuthProfile,
  deviceLabel?: string,
): Promise<AuthSessionDto> {
  let user: User;
  try {
    user = await resolveOAuthUser(provider, profile);
  } catch (err) {
    // สองแท็บกดพร้อมกัน → ตัวหลังชน unique index · รอบสองจะเจอบัญชีที่ตัวแรกเพิ่งสร้าง/ผูก
    if (!isUniqueViolation(err)) throw err;
    user = await resolveOAuthUser(provider, profile);
  }
  return issueSession(user, deviceLabel);
}
