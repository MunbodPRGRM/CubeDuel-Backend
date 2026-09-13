import { createHash, createHmac } from 'node:crypto';

/**
 * ตรรกะล้วนของการเข้าสู่ระบบด้วย Google (ADR-058) และ Facebook (ADR-070)
 * ไม่แตะ DB ไม่แตะเครือข่าย จึงเขียน unit test ได้ · ส่วนที่คุยกับ provider และ DB อยู่ใน `services/oauth.service.ts`
 */

/** ชื่อ provider ที่อยู่ใน path (`/auth/oauth/<slug>`) และใน `?provider=` ตอนพากลับพร้อม error */
export type OAuthProviderSlug = 'google' | 'facebook';

/** รหัสที่ส่งกลับไปหน้าเข้าสู่ระบบเป็น `?oauth_error=` (api-contract.md ข้อ 2) */
export type OAuthErrorCode =
  | 'unavailable'
  | 'cancelled'
  | 'invalid_state'
  | 'email_unverified'
  | 'email_missing'
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

/** ไม่มี `provider` = ไม่รู้ว่ามาจากปุ่มไหน (เช่น rate limit) → หน้าเว็บใช้ข้อความกลาง ๆ (ADR-070 ข้อ 5) */
export function loginErrorUrl(base: string, code: OAuthErrorCode, provider?: OAuthProviderSlug): string {
  const query = provider ? `oauth_error=${code}&provider=${provider}` : `oauth_error=${code}`;
  return frontendUrlFor(base, `/login?${query}`);
}

// ---------------------------------------------------------------- state + PKCE

/** ของที่ต้องจำไว้ระหว่างไป-กลับ provider — เก็บใน cookie `cubeduel_oauth` */
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

// ---------------------------------------------------------------- ข้อมูลผู้ใช้จาก provider

/** ข้อมูลที่ใช้จาก provider — เท่านี้พอสำหรับ `database-schema.md` ตารางที่ 2 */
export interface OAuthProfile {
  /** รหัสผู้ใช้ฝั่ง provider — ไม่เปลี่ยนตลอดชีพ ต่างจากอีเมล → ใช้เป็น `provider_user_id` */
  sub: string;
  /**
   * ตัวพิมพ์เล็กแล้ว ให้ตรงกับที่ `register` เก็บ
   * `null` ได้เฉพาะ Facebook (สมัครด้วยเบอร์โทร / ไม่ให้สิทธิ์) — ผู้เรียกตอบ `email_missing` ถ้าต้องใช้ (ADR-070 ข้อ 4)
   */
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

function cleanName(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

// ---------------------------------------------------------------- Google id_token

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * อ่าน claim ใน id_token ที่ได้จาก token endpoint ของ Google
 *
 * **ไม่ตรวจลายเซ็น** — token มาจาก Google โดยตรงผ่าน TLS ด้วย client secret ของเรา (ADR-058 ข้อ 2.3)
 * แต่ยังต้องตรวจว่าออกโดย Google · ออกให้แอปเรา · ยังไม่หมดอายุ · มีรหัสผู้ใช้กับอีเมล
 * ผิดข้อไหน = throw (ผู้เรียกตอบ `failed` + เขียน log)
 */
export function readGoogleIdToken(idToken: string, clientId: string, nowMs = Date.now()): OAuthProfile {
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

  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    // เอกสารเก่าของ Google เคยส่งเป็นสตริง "true"
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: cleanName(claims.name),
  };
}

// ---------------------------------------------------------------- Facebook Graph API

/**
 * `appsecret_proof` = HMAC-SHA256(access_token, app secret) เป็น hex (ADR-070 ข้อ 2)
 * ต่อให้ access_token หลุด คนที่ไม่มี app secret ก็เอาไปเรียก Graph API ในนามแอปเราไม่ได้
 */
export function facebookAppSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * อ่านผลของ `GET /me?fields=id,name,email`
 *
 * - `id` = app-scoped user id (สตริงตัวเลข) → `provider_user_id`
 * - ไม่มี `email` = สมัคร Facebook ด้วยเบอร์โทร หรือไม่ให้สิทธิ์ → `email: null` (ไม่ throw — บัญชีที่ผูกไว้แล้วยังเข้าได้)
 * - **มีอีเมล = ถือว่ายืนยันแล้ว** — Facebook ไม่มี `email_verified` (ADR-070 ข้อ 3 ความเสี่ยงที่ยอมรับ)
 */
export function readFacebookProfile(body: unknown): OAuthProfile {
  if (!body || typeof body !== 'object') throw new Error('ผลจาก Facebook /me ไม่ใช่ object');
  const me = body as Record<string, unknown>;
  if (typeof me.id !== 'string' || !/^\d{1,64}$/.test(me.id)) {
    throw new Error(`ผลจาก Facebook /me ไม่มี id ที่ถูกต้อง (${String(me.id)})`);
  }
  const email =
    typeof me.email === 'string' && me.email.includes('@') ? me.email.trim().toLowerCase() : null;
  return {
    sub: me.id,
    email,
    emailVerified: email !== null,
    name: cleanName(me.name),
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
