import { createHash } from 'node:crypto';

/**
 * ตรรกะล้วนของการเข้าสู่ระบบด้วย Google (ADR-058) — ไม่แตะ DB ไม่แตะเครือข่าย จึงเขียน unit test ได้
 * ส่วนที่คุยกับ Google และ DB อยู่ใน `services/oauth.service.ts`
 */

/** รหัสที่ส่งกลับไปหน้าเข้าสู่ระบบเป็น `?oauth_error=` (api-contract.md ข้อ 2) */
export type OAuthErrorCode =
  | 'unavailable'
  | 'cancelled'
  | 'invalid_state'
  | 'email_unverified'
  | 'suspended'
  | 'rate_limited'
  | 'failed';

// ---------------------------------------------------------------- URL ของ frontend

export const DEFAULT_RETURN_TO = '/';
const RETURN_TO_MAX_LENGTH = 200;

/**
 * หน้าที่จะพากลับไปหลังล็อกอินเสร็จ — ต้องเป็นพาธในเว็บเราเท่านั้น ไม่งั้นเท่ากับเปิด open redirect
 * `//evil.com` กับ `/\evil.com` เบราว์เซอร์ตีความเป็นโดเมนอื่น · ผิดกฎ = กลับหน้าแรกเงียบ ๆ
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > RETURN_TO_MAX_LENGTH) return DEFAULT_RETURN_TO;
  // พาธของแอปเป็น ASCII ล้วน — ตัดทั้งช่องว่าง ตัวควบคุม และ backslash ทิ้งด้วยกฎเดียว
  if (!/^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/.test(value)) return DEFAULT_RETURN_TO;
  return value;
}

/** `FRONTEND_URL` อาจมี `/` ต่อท้ายหรือไม่ก็ได้ — ต่อพาธแล้วต้องไม่กลายเป็น `//` */
export function frontendUrlFor(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

export function loginErrorUrl(base: string, code: OAuthErrorCode): string {
  return frontendUrlFor(base, `/login?oauth_error=${code}`);
}

// ---------------------------------------------------------------- state + PKCE

/** ของที่ต้องจำไว้ระหว่างไป-กลับ Google — เก็บใน cookie `cubeduel_oauth` */
export interface OAuthFlowCookie {
  state: string;
  verifier: string;
  returnTo: string;
}

export function encodeFlowCookie(flow: OAuthFlowCookie): string {
  return Buffer.from(JSON.stringify(flow)).toString('base64url');
}

/** cookie หาย / ถูกแก้ / รูปร่างผิด → `null` (ผู้เรียกตอบ `invalid_state`) */
export function decodeFlowCookie(raw: unknown): OAuthFlowCookie | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1_000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<
      Record<keyof OAuthFlowCookie, unknown>
    >;
    if (typeof parsed.state !== 'string' || !parsed.state) return null;
    if (typeof parsed.verifier !== 'string' || !parsed.verifier) return null;
    return { state: parsed.state, verifier: parsed.verifier, returnTo: safeReturnTo(parsed.returnTo) };
  } catch {
    return null;
  }
}

/** PKCE S256 (RFC 7636): `BASE64URL(SHA256(verifier))` */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ---------------------------------------------------------------- id_token

/** ข้อมูลที่ใช้จาก Google — เท่านี้พอสำหรับ `database-schema.md` ตารางที่ 2 */
export interface GoogleProfile {
  /** รหัสผู้ใช้ฝั่ง Google — ไม่เปลี่ยนตลอดชีพ ต่างจากอีเมล → ใช้เป็น `provider_user_id` */
  sub: string;
  /** ตัวพิมพ์เล็กแล้ว ให้ตรงกับที่ `register` เก็บ */
  email: string;
  emailVerified: boolean;
  name: string | null;
}

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * อ่าน claim ใน id_token ที่ได้จาก token endpoint ของ Google
 *
 * **ไม่ตรวจลายเซ็น** — token มาจาก Google โดยตรงผ่าน TLS ด้วย client secret ของเรา (ADR-058 ข้อ 2.3)
 * แต่ยังต้องตรวจว่าออกโดย Google · ออกให้แอปเรา · ยังไม่หมดอายุ · มีรหัสผู้ใช้กับอีเมล
 * ผิดข้อไหน = throw (ผู้เรียกตอบ `failed` + เขียน log)
 */
export function readGoogleIdToken(idToken: string, clientId: string, nowMs = Date.now()): GoogleProfile {
  const payload = idToken.split('.')[1];
  if (!payload || idToken.split('.').length !== 3) throw new Error('id_token ไม่ใช่ JWT');

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('อ่าน payload ของ id_token ไม่ออก');
  }

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) {
    throw new Error(`id_token ไม่ได้ออกโดย Google (iss = ${String(claims.iss)})`);
  }
  const aud = claims.aud;
  if (aud !== clientId && !(Array.isArray(aud) && aud.includes(clientId))) {
    throw new Error('id_token ไม่ได้ออกให้แอปนี้ (aud ไม่ตรง)');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    throw new Error('id_token หมดอายุแล้ว');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token ไม่มี sub');
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) {
    throw new Error('id_token ไม่มีอีเมล (ขอ scope email หรือยัง?)');
  }

  const name = typeof claims.name === 'string' ? claims.name.trim() : '';
  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    // เอกสารเก่าของ Google เคยส่งเป็นสตริง "true"
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: name || null,
  };
}

// ---------------------------------------------------------------- username ของบัญชีใหม่

/** เผื่อที่ให้ต่อ `_` + เลขสุ่มได้อีก 9 ตัวโดยไม่เกินเพดาน 50 ของ username */
export const OAUTH_USERNAME_BASE_MAX = 40;

/**
 * ตั้งต้น username จากอีเมล (database-schema.md ตารางที่ 2 ข้อ 3 · ADR-058 ข้อ 5)
 * ต้องผ่านกฎเดียวกับ `register`: `a-z A-Z 0-9 _` · ห้ามขึ้นต้นด้วยตัวเลข · 3–50 ตัว · ห้ามชนชื่อสงวน `deleted_user_`
 * ผลลัพธ์ยังอาจซ้ำกับคนอื่น — ผู้เรียกเป็นคนต่อเลขสุ่มเอง
 */
export function usernameBaseFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const cleaned = local
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!cleaned) return 'cuber';
  const needsPrefix = !/^[A-Za-z]/.test(cleaned) || cleaned.length < 3 || /^deleted_user_/i.test(cleaned);
  const base = needsPrefix ? `cuber_${cleaned}` : cleaned;
  return base.slice(0, OAUTH_USERNAME_BASE_MAX);
}
