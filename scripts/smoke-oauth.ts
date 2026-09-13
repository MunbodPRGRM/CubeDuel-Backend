/**
 * สโมคเทสเข้าสู่ระบบด้วย Google (เฟส 2 — ADR-058) + Facebook (ADR-070)
 *
 * ต้องรัน `npm run dev` ไว้ก่อน · ควรเปิด server ด้วย `DISABLE_RATE_LIMIT=true`
 *
 * ขาที่แลก `code` กับ provider จริงทดสอบอัตโนมัติไม่ได้ — ไม่มีทางได้ code ของจริงโดยไม่มีคนกดเลือกบัญชี
 * จึงแบ่งเป็นสองส่วน:
 *   1. ผ่านสาย HTTP — ขาเริ่ม (redirect · cookie · PKCE · returnTo) และ callback ทุกทางที่ผิด
 *   2. เรียก `signInWithOAuth()` ตรง ๆ ด้วยข้อมูล provider ปลอม — ตรรกะหา/ผูก/สร้างบัญชีทั้งหมด
 *      (ข้อยกเว้นของ `smoke-helpers.ts` ที่ว่าห้ามเรียกฟังก์ชันฝั่ง server) แล้วเอา token ที่ได้ไปยิง endpoint จริงต่อ
 * บัญชีทดสอบสร้างใหม่ทุกรอบแล้วลบทิ้งตอนจบ
 *
 *   npm run smoke:oauth
 */
import { OAuthProvider, PrismaClient, UserStatus } from '@prisma/client';
import { AppError } from '../src/lib/errors.js';
import { decodeFlowCookie, pkceChallenge, type OAuthProfile } from '../src/lib/oauth.js';
import { hashPassword } from '../src/lib/password.js';
import { hashToken } from '../src/lib/tokens.js';
import { OAuthFlowError, signInWithOAuth } from '../src/services/oauth.service.js';
import { API, check, summary } from './smoke-helpers.js';

const prisma = new PrismaClient();
const signInWithGoogle = (profile: OAuthProfile) => signInWithOAuth(OAuthProvider.GOOGLE, profile);
const signInWithFacebook = (profile: OAuthProfile) => signInWithOAuth(OAuthProvider.FACEBOOK, profile);
const PASSWORD = 'LinkPass123';
const NEW_PASSWORD = 'GooglePass456';

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  location: string;
  cookies: string[];
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; cookie?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // redirect ตอบเป็นข้อความธรรมดา
  }
  return { status: res.status, body, location: res.headers.get('location') ?? '', cookies: res.headers.getSetCookie() };
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const line = cookies.find((c) => c.startsWith(`${name}=`));
  return line ? decodeURIComponent(line.slice(name.length + 1).split(';')[0]!) : undefined;
}

const errorOf = (location: string) => new URL(location).searchParams.get('oauth_error');
const providerOf = (location: string) => new URL(location).searchParams.get('provider');

async function expectFlowError(label: string, run: Promise<unknown>, test: (err: unknown) => boolean) {
  try {
    await run;
    check(label, false, 'ผ่านทั้งที่ควรถูกปฏิเสธ');
  } catch (err) {
    check(label, test(err), err);
  }
}

// ------------------------------------------------------------------ ส่วนที่ 1: HTTP

interface HttpProvider {
  slug: 'google' | 'facebook';
  label: string;
  envName: string;
  authUrl: string;
  /** ตรวจเพิ่มเฉพาะ provider */
  extra: (q: URLSearchParams) => void;
}

const HTTP_PROVIDERS: HttpProvider[] = [
  {
    slug: 'google',
    label: 'Google',
    envName: 'GOOGLE_CLIENT_ID/SECRET',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    extra: (q) => check('prompt=select_account', q.get('prompt') === 'select_account'),
  },
  {
    slug: 'facebook',
    label: 'Facebook',
    envName: 'FACEBOOK_CLIENT_ID/SECRET',
    authUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
    extra: (q) => check('auth_type=rerequest (ถามสิทธิ์อีเมลใหม่ได้ — ADR-070 ข้อ 2)', q.get('auth_type') === 'rerequest'),
  },
];

async function httpFlow({ slug, label, envName, authUrl, extra }: HttpProvider): Promise<void> {
  const base = `/auth/oauth/${slug}`;
  console.log(`\n[${label}] 1) ขาเริ่ม GET ${base}`);
  const start = await call('GET', `${base}?returnTo=/practice`);
  check('ตอบ 302', start.status === 302, start.status);

  if (start.location.includes('oauth_error=unavailable')) {
    console.log(`  ⏭️  server ไม่ได้ตั้ง ${envName} — ตรวจได้แค่ว่าพากลับหน้าเข้าสู่ระบบ`);
    check(`แนบ provider=${slug}`, providerOf(start.location) === slug, start.location);
    const cb = await call('GET', `${base}/callback?code=x&state=y`);
    check('callback ก็ตอบ unavailable', errorOf(cb.location) === 'unavailable', cb.location);
    return;
  }

  const target = new URL(start.location);
  check(`ไปหน้าของ ${label}`, target.origin + target.pathname === authUrl, start.location);
  const q = target.searchParams;
  check('response_type=code + scope มี email', q.get('response_type') === 'code' && /\bemail\b/.test(q.get('scope') ?? ''));
  check('redirect_uri ชี้มา callback ของเรา', (q.get('redirect_uri') ?? '').endsWith(`/api/v1${base}/callback`), q.get('redirect_uri'));
  check('PKCE แบบ S256', q.get('code_challenge_method') === 'S256' && !!q.get('code_challenge'));
  extra(q);

  const rawCookie = start.cookies.find((c) => c.startsWith('cubeduel_oauth='));
  check('ตั้ง cookie cubeduel_oauth', !!rawCookie, start.cookies);
  check('cookie: HttpOnly · SameSite=Lax · path เฉพาะ /api/v1/auth/oauth', !!rawCookie && /HttpOnly/i.test(rawCookie) && /SameSite=Lax/i.test(rawCookie) && /Path=\/api\/v1\/auth\/oauth/i.test(rawCookie), rawCookie);
  const flow = decodeFlowCookie(cookieValue(start.cookies, 'cubeduel_oauth'));
  check('state ใน cookie ตรงกับที่ส่งให้ provider', flow?.state === q.get('state'), flow);
  check('code_challenge = SHA256(verifier ใน cookie)', !!flow && pkceChallenge(flow.verifier) === q.get('code_challenge'));
  check('returnTo ถูกจำไว้', flow?.returnTo === '/practice', flow?.returnTo);

  const evil = await call('GET', `${base}?returnTo=${encodeURIComponent('//evil.com')}`);
  check('returnTo=//evil.com → จำเป็น / (กัน open redirect)', decodeFlowCookie(cookieValue(evil.cookies, 'cubeduel_oauth'))?.returnTo === '/');

  const cookie = `cubeduel_oauth=${encodeURIComponent(cookieValue(start.cookies, 'cubeduel_oauth')!)}`;
  const state = encodeURIComponent(flow?.state ?? '');

  console.log(`\n[${label}] 2) callback ทางที่ผิด`);
  const noCookie = await call('GET', `${base}/callback?code=abc&state=${state}`);
  check('ไม่มี cookie → invalid_state', noCookie.status === 302 && errorOf(noCookie.location) === 'invalid_state', noCookie.location);
  check('พากลับหน้า /login ของเว็บ', new URL(noCookie.location).pathname === '/login', noCookie.location);
  check(`แนบ provider=${slug} (ADR-070 ข้อ 5)`, providerOf(noCookie.location) === slug, noCookie.location);

  const wrongState = await call('GET', `${base}/callback?code=abc&state=forged`, { cookie });
  check('state ไม่ตรง → invalid_state', errorOf(wrongState.location) === 'invalid_state', wrongState.location);
  check('cookie ถูกลบทิ้งหลัง callback', wrongState.cookies.some((c) => c.startsWith('cubeduel_oauth=;') && /Expires=Thu, 01 Jan 1970/i.test(c)), wrongState.cookies);

  const denied = await call('GET', `${base}/callback?error=access_denied&state=${state}`, { cookie });
  check('ผู้ใช้กดยกเลิกที่ provider → cancelled', errorOf(denied.location) === 'cancelled', denied.location);

  const noCode = await call('GET', `${base}/callback?state=${state}`, { cookie });
  check('ไม่มี code → invalid_state', errorOf(noCode.location) === 'invalid_state', noCode.location);

  // state ถูกต้อง แต่ code ปลอม → server ยิงไปแลกกับ provider จริงแล้วโดนปฏิเสธ
  const bogus = await call('GET', `${base}/callback?code=bogus-code&state=${state}`, { cookie });
  check(`code ปลอม → failed (${label} ปฏิเสธ · ดู log ของ server)`, errorOf(bogus.location) === 'failed', bogus.location);
  check('ไม่ออก refresh cookie ให้', !bogus.cookies.some((c) => c.startsWith('cubeduel_refresh=') && !c.startsWith('cubeduel_refresh=;')), bogus.cookies);
}

// ------------------------------------------------------------------ ส่วนที่ 2: หา/ผูก/สร้างบัญชี

async function accountFlow(stamp: number, created: Set<number>): Promise<void> {
  let n = 0;
  const profile = (over: Partial<OAuthProfile> = {}): OAuthProfile => ({
    sub: `smoke-${stamp}-${++n}`,
    email: `oauth_probe_${stamp}_${n}@smoke.local`,
    emailVerified: true,
    name: 'ทดสอบ Google 🧊',
    ...over,
  });
  const track = <T extends { user: { userId: number } }>(session: T) => {
    created.add(session.user.userId);
    return session;
  };

  console.log('\n3) บัญชีใหม่');
  const p1 = profile();
  const s1 = track(await signInWithGoogle(p1));
  const u1 = await prisma.user.findUniqueOrThrow({ where: { userId: s1.user.userId } });
  check('ไม่มีรหัสผ่าน (password_hash = NULL)', u1.passwordHash === null);
  check('hasPassword = false ใน session', s1.user.hasPassword === false, s1.user);
  check('อีเมลตรงกับของ Google', u1.email === p1.email, u1.email);
  check(`username มาจากอีเมล (${u1.username})`, u1.username.startsWith(`oauth_probe_${stamp}`), u1.username);
  check('nickname = ชื่อจาก Google', u1.nickname === 'ทดสอบ Google 🧊', u1.nickname);
  const ratings = await prisma.rating.findMany({ where: { userId: u1.userId } });
  check('Rating ครบ 4 แถว × 1000', ratings.length === 4 && ratings.every((r) => r.eloRating === 1000), ratings.length);
  const links = await prisma.oAuthAccount.findMany({ where: { userId: u1.userId } });
  check('ผูก OAuthAccount GOOGLE 1 แถว', links.length === 1 && links[0]?.provider === 'GOOGLE' && links[0].providerUserId === p1.sub, links);

  console.log('\n4) กลับมาด้วย Google บัญชีเดิม');
  const again = track(await signInWithGoogle({ ...p1, email: 'changed@smoke.local', emailVerified: false }));
  check('เข้าบัญชีเดิมจาก sub (อีเมลเปลี่ยน/ไม่ยืนยันก็ไม่สน)', again.user.userId === u1.userId, again.user.userId);
  check('ไม่เกิดแถวผูกซ้ำ', (await prisma.oAuthAccount.count({ where: { userId: u1.userId } })) === 1);

  const me = await call('GET', '/users/me', { token: again.accessToken });
  check('GET /users/me ด้วย token ที่ได้ → 200 hasPassword false', me.status === 200 && me.body.data?.hasPassword === false, me.body);
  const pwLogin = await call('POST', '/auth/login', { body: { identifier: u1.username, password: 'Whatever123' } });
  check('ล็อกอินด้วยรหัสผ่าน → 401 บอกให้ใช้ Google', pwLogin.status === 401 && /Google/.test(pwLogin.body?.error?.message ?? ''), pwLogin.body);

  console.log('\n5) username ชนกัน');
  const local = `oauth_probe_${stamp}_1`;
  const clash = track(await signInWithGoogle(profile({ email: `${local}@other.local` })));
  check(`ได้ username ต่อเลขสุ่ม (${clash.user.username})`, new RegExp(`^${local}_\\d{4}$`).test(clash.user.username), clash.user.username);

  console.log('\n6) อีเมลตรงกับบัญชีรหัสผ่านเดิม → ผูก + ล้างรหัสผ่าน + เพิกถอนเซสชัน (ADR-058 ข้อ 4)');
  const owner = await prisma.user.create({
    data: {
      username: `link_probe_${stamp}`,
      email: `link_probe_${stamp}@smoke.local`,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  created.add(owner.userId);
  const before = await call('POST', '/auth/login', { body: { identifier: owner.username, password: PASSWORD } });
  check('ก่อนผูก ล็อกอินด้วยรหัสผ่านได้', before.status === 200, before.status);
  const linked = track(await signInWithGoogle(profile({ email: owner.email.toUpperCase() })));
  check('เข้าบัญชีเดิม (อีเมลตัวพิมพ์ใหญ่ก็ตรง)', linked.user.userId === owner.userId, linked.user.userId);
  check('รหัสผ่านเดิมถูกล้าง', (await prisma.user.findUniqueOrThrow({ where: { userId: owner.userId } })).passwordHash === null);
  // ตรวจจาก DB ไม่ยิง token เก่า — ยิงแล้ว server จะนับเป็นการใช้ token ซ้ำ (ADR-013) แล้วเพิกถอนเซสชันใหม่ไปด้วย
  const oldRow = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(before.body.data?.refreshToken ?? '') } });
  check('เซสชันที่ออกก่อนผูกถูกเพิกถอน', !!oldRow?.revokedAt, oldRow);
  const newSession = await call('POST', '/auth/refresh', { body: { refreshToken: linked.refreshToken } });
  check('เซสชันจาก Google ใช้ได้', newSession.status === 200, newSession.status);
  const oldPw = await call('POST', '/auth/login', { body: { identifier: owner.username, password: PASSWORD } });
  check('รหัสผ่านเดิมใช้ไม่ได้แล้ว', oldPw.status === 401, oldPw.status);

  console.log('\n7) อีเมลที่ Google ไม่ยืนยัน');
  const unverified = profile({ emailVerified: false });
  await expectFlowError('→ email_unverified', signInWithGoogle(unverified), (e) => e instanceof OAuthFlowError && e.code === 'email_unverified');
  check('ไม่สร้างบัญชี', (await prisma.user.count({ where: { email: unverified.email } })) === 0);
  const victim = await prisma.user.create({
    data: { username: `victim_${stamp}`, email: `victim_${stamp}@smoke.local`, passwordHash: await hashPassword(PASSWORD) },
  });
  created.add(victim.userId);
  await expectFlowError('อีเมลตรงบัญชีเดิมแต่ไม่ยืนยัน → ไม่ผูก', signInWithGoogle(profile({ email: victim.email, emailVerified: false })), (e) => e instanceof OAuthFlowError);
  const victimAfter = await prisma.user.findUniqueOrThrow({ where: { userId: victim.userId } });
  check('บัญชีเดิมไม่ถูกแตะ (ยังมีรหัสผ่าน · ไม่มีแถวผูก)', victimAfter.passwordHash !== null && (await prisma.oAuthAccount.count({ where: { userId: victim.userId } })) === 0);

  console.log('\n8) บัญชีที่ถูกระงับ');
  const banned = await prisma.user.create({
    data: { username: `banned_${stamp}`, email: `banned_${stamp}@smoke.local`, status: UserStatus.SUSPENDED },
  });
  created.add(banned.userId);
  await expectFlowError('→ E_ACCOUNT_SUSPENDED', signInWithGoogle(profile({ email: banned.email })), (e) => e instanceof AppError && e.code === 'E_ACCOUNT_SUSPENDED');
  check('ไม่สร้างแถวผูกให้บัญชีที่ถูกระงับ', (await prisma.oAuthAccount.count({ where: { userId: banned.userId } })) === 0);

  console.log('\n9) สองแท็บสร้างบัญชีพร้อมกัน');
  const racer = profile();
  const both = await Promise.all([signInWithGoogle(racer), signInWithGoogle(racer)]);
  both.forEach(track);
  check('ผ่านทั้งคู่และได้บัญชีเดียวกัน', both[0].user.userId === both[1].user.userId, both.map((s) => s.user.userId));
  check('มีผู้ใช้อีเมลนี้คนเดียว', (await prisma.user.count({ where: { email: racer.email } })) === 1);

  console.log('\n10) ผู้ใช้ Google ตั้งรหัสผ่านครั้งแรก (ไม่ต้องใส่รหัสเดิม)');
  const setPw = await call('POST', '/auth/change-password', { token: again.accessToken, body: { newPassword: NEW_PASSWORD } });
  check('→ 200', setPw.status === 200, setPw.body);
  const withNew = await call('POST', '/auth/login', { body: { identifier: u1.username, password: NEW_PASSWORD } });
  check('ล็อกอินด้วยรหัสใหม่ได้ + hasPassword = true', withNew.status === 200 && withNew.body.data?.user?.hasPassword === true, withNew.body);
  const needOld = await call('POST', '/auth/change-password', { token: withNew.body.data?.accessToken, body: { newPassword: PASSWORD } });
  check('มีรหัสผ่านแล้ว → ครั้งต่อไปต้องใส่รหัสเดิม (400)', needOld.status === 400 && !!needOld.body.error?.fields?.currentPassword, needOld.body);

  console.log('\n11) ผู้ใช้ Google ที่ไม่มีรหัสผ่านลบบัญชีได้โดยไม่ต้องยืนยันรหัส');
  const del = await call('DELETE', '/auth/account', { token: clash.accessToken, body: {} });
  check('→ 200', del.status === 200, del.body);
  check('แถวผูก Google ถูกตัดทิ้ง', (await prisma.oAuthAccount.count({ where: { userId: clash.user.userId } })) === 0);
  const clashSub = await prisma.user.findUniqueOrThrow({ where: { userId: clash.user.userId } });
  check('เป็น soft delete (deleted_user_{id})', clashSub.username === `deleted_user_${clash.user.userId}`, clashSub.username);
  const reborn = track(await signInWithGoogle({ sub: `smoke-${stamp}-${n}`, email: `${local}@other.local`, emailVerified: true, name: null }));
  check('กลับมาด้วย Google เดิม = บัญชีใหม่ ไม่ใช่บัญชีที่ลบไป', reborn.user.userId !== clash.user.userId, reborn.user.userId);

  // ---------------------------------------------------------------- Facebook (ADR-070)
  const fbProfile = (over: Partial<OAuthProfile> = {}): OAuthProfile => ({
    sub: `${stamp}${++n}`,
    email: `fb_probe_${stamp}_${n}@smoke.local`,
    emailVerified: true,
    name: 'ทดสอบ Facebook',
    ...over,
  });

  console.log('\n12) Facebook บัญชีใหม่');
  const fb1 = fbProfile();
  const fbSession = track(await signInWithFacebook(fb1));
  const fbLinks = await prisma.oAuthAccount.findMany({ where: { userId: fbSession.user.userId } });
  check('ผูก OAuthAccount FACEBOOK 1 แถว', fbLinks.length === 1 && fbLinks[0]?.provider === 'FACEBOOK' && fbLinks[0].providerUserId === fb1.sub, fbLinks);
  check('Rating ครบ 4 แถว', (await prisma.rating.count({ where: { userId: fbSession.user.userId } })) === 4);
  check('nickname = ชื่อจาก Facebook', fbSession.user.nickname === 'ทดสอบ Facebook', fbSession.user);

  console.log('\n13) sub ชุดเดียวกันแต่คนละ provider = คนละบัญชี');
  const sameSub = track(await signInWithGoogle(profile({ sub: fb1.sub })));
  check('Google ที่ sub บังเอิญตรงกับ Facebook ไม่เข้าบัญชี Facebook', sameSub.user.userId !== fbSession.user.userId, sameSub.user.userId);

  console.log('\n14) อีเมลเดียวกับบัญชี Google เดิม → ผูก Facebook เพิ่มเข้าบัญชีเดียวกัน');
  const both2 = track(await signInWithFacebook(fbProfile({ email: u1.email })));
  check('เข้าบัญชีเดิม', both2.user.userId === u1.userId, both2.user.userId);
  const providers = (await prisma.oAuthAccount.findMany({ where: { userId: u1.userId } })).map((l) => l.provider).sort();
  check('มีแถวผูกทั้ง FACEBOOK และ GOOGLE', providers.join(',') === 'FACEBOOK,GOOGLE', providers);

  console.log('\n15) Facebook ไม่ส่งอีเมล (ADR-070 ข้อ 4)');
  const noEmail = fbProfile({ email: null, emailVerified: false });
  await expectFlowError('ยังไม่เคยผูก → email_missing', signInWithFacebook(noEmail), (e) => e instanceof OAuthFlowError && e.code === 'email_missing');
  check('ไม่สร้างแถวผูก', (await prisma.oAuthAccount.count({ where: { provider: 'FACEBOOK', providerUserId: noEmail.sub } })) === 0);
  const linkedNoEmail = track(await signInWithFacebook({ ...fb1, email: null, emailVerified: false }));
  check('เคยผูกแล้ว → เข้าได้แม้ครั้งนี้ไม่มีอีเมล', linkedNoEmail.user.userId === fbSession.user.userId, linkedNoEmail.user.userId);
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const created = new Set<number>();
  try {
    for (const provider of HTTP_PROVIDERS) await httpFlow(provider);
    await accountFlow(stamp, created);
  } finally {
    // Rating ไม่ได้ cascade (ADR-022) — ลบก่อน · OAuthAccount / RefreshToken หายตามด้วย ON DELETE CASCADE
    const ids = [...created];
    await prisma.rating.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { userId: { in: ids } } });
    await prisma.$disconnect();
  }
  process.exit(summary('(เฟส 2 — เข้าสู่ระบบด้วย Google/Facebook)'));
}

void main();
