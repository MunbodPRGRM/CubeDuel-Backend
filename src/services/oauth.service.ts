import { randomInt } from 'node:crypto';
import { OAuthProvider, Prisma, type User } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import {
  readGoogleIdToken,
  usernameBaseFromEmail,
  type GoogleProfile,
  type OAuthErrorCode,
} from '../lib/oauth.js';
import type { AuthSessionDto } from '../types/api.js';
import {
  assertUsable,
  createInitialRatings,
  issueSession,
  revokeAllRefreshTokens,
} from './auth.service.js';

/**
 * เข้าสู่ระบบด้วย Google — Authorization Code + PKCE เขียนเองด้วย `fetch` (ADR-058 ข้อ 2)
 * กฎการหา/ผูก/สร้างบัญชี: docs/database-schema.md ตารางที่ 2 + ADR-058 ข้อ 4
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Google ไม่ตอบภายในเวลานี้ = ถือว่าล้ม ไม่ปล่อยให้ผู้ใช้ค้างหน้าขาวไปเรื่อย ๆ */
const GOOGLE_TIMEOUT_MS = 10_000;

/** ความผิดพลาดที่รู้ความหมาย → กลายเป็น `?oauth_error=<code>` ตรง ๆ (ที่เหลือเป็น `failed`) */
export class OAuthFlowError extends Error {
  readonly code: OAuthErrorCode;

  constructor(code: OAuthErrorCode, message: string = code) {
    super(message);
    this.name = 'OAuthFlowError';
    this.code = code;
  }
}

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
export async function exchangeGoogleCode(code: string, codeVerifier: string): Promise<GoogleProfile> {
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
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
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

async function resolveGoogleUser(profile: GoogleProfile): Promise<User> {
  // 1. เคยผูกไว้แล้ว → เข้าบัญชีนั้น
  const linked = await prisma.oAuthAccount.findUnique({
    where: {
      provider_providerUserId: { provider: OAuthProvider.GOOGLE, providerUserId: profile.sub },
    },
    include: { user: true },
  });
  if (linked) return assertUsable(linked.user);

  // 2. จะผูกหรือสร้างบัญชีจากอีเมล อีเมลต้องเป็นของเขาจริง
  if (!profile.emailVerified) throw new OAuthFlowError('email_unverified');
  // `readGoogleIdToken()` ทำตัวพิมพ์เล็กให้แล้ว — ทำซ้ำตรงนี้เพราะการหาบัญชีเดิมพังเงียบ ๆ ถ้าพลาด
  const email = profile.email.trim().toLowerCase();
  if (email.length > 100) throw new Error('อีเมลจาก Google ยาวเกิน 100 ตัว เก็บลง User.email ไม่ได้');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && !existing.deletedAt) {
    // ตรวจก่อนผูก — ไม่สร้างแถว OAuthAccount ให้บัญชีที่ถูกระงับ
    const usable = await assertUsable(existing);
    return prisma.$transaction(async (tx) => {
      await tx.oAuthAccount.create({
        data: { userId: usable.userId, provider: OAuthProvider.GOOGLE, providerUserId: profile.sub },
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
      data: { userId: created.userId, provider: OAuthProvider.GOOGLE, providerUserId: profile.sub },
    });
    return created;
  });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function signInWithGoogle(
  profile: GoogleProfile,
  deviceLabel?: string,
): Promise<AuthSessionDto> {
  let user: User;
  try {
    user = await resolveGoogleUser(profile);
  } catch (err) {
    // สองแท็บกดพร้อมกัน → ตัวหลังชน unique index · รอบสองจะเจอบัญชีที่ตัวแรกเพิ่งสร้าง/ผูก
    if (!isUniqueViolation(err)) throw err;
    user = await resolveGoogleUser(profile);
  }
  return issueSession(user, deviceLabel);
}
