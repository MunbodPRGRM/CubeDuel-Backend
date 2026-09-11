/**
 * ตรวจความปลอดภัยผ่านสายจริง — ด่านสิทธิ์ทุก endpoint · input ประสงค์ร้าย · socket (เฟส 10 ก้อนที่ 4 — ADR-055)
 *
 * ต้องมี server รันอยู่บน **เครื่องเดียวกัน** (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * รันด้วย: npm run smoke:security
 *
 * **เซ็น token เองด้วย secret ใน `.env`** (เหมือน `load:rooms`) — ไม่กินโควตาล็อกอิน 10 ครั้ง/15 นาที
 * และเคสสำคัญที่สุดทำด้วยวิธีอื่นไม่ได้: token ที่ลายเซ็นถูกต้องแต่ **อ้าง role เป็น admin**
 * ต้องโดนปฏิเสธ เพราะ server ต้องอ่าน role จาก DB ไม่ใช่เชื่อที่ token บอก
 *
 * ครอบ:
 *   1. รายชื่อ endpoint — ไล่จาก router ของ Express จริง ทุกตัวต้องมีระดับสิทธิ์ในตาราง `access()`
 *      และตรงกับ `docs/api-contract.md` (ถ้าหาไฟล์เจอ — docs อยู่คนละ repo)
 *   2. ด่านสิทธิ์ของทุก endpoint × ไม่มี token / token ปลอม 9 แบบ / สมาชิก / แอดมิน
 *   3. ข้อมูลส่วนตัวไม่หลุดทาง endpoint สาธารณะ · บัญชีที่ถูกลบถือว่าไม่มีอยู่
 *   4. input ประสงค์ร้าย — SQL injection · id เกิน INT4 · JSON พัง · body ใหญ่เกิน · object แทน string
 *   5. header · CORS · path traversal ของ `/uploads`
 *   6. socket — handshake ปลอม · ผู้ชมส่งคำสั่งผู้เล่น · คนที่ไม่ใช่ host กดเริ่ม · userId ใน payload ไม่มีผล · rate limit
 *
 * **ไม่เปลี่ยนข้อมูลจริง** — request ที่ผ่านด่านไปได้ส่ง body ว่าง/id ที่ไม่มีอยู่ ให้ไปตกที่ validation
 * ข้อยกเว้นเดียวคือบัญชี `deleted_user_*` ที่สคริปต์สร้างขึ้นเองแล้วลบทิ้งตอนจบ
 */
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CubeType, PrismaClient, UserRole, UserStatus } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { io, type Socket } from 'socket.io-client';
import { API_BASE_PATH, createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { signAccessToken, signRefreshToken } from '../src/lib/jwt.js';
import { API, SERVER_URL, check, connect, emit, summary, waitFor } from './smoke-helpers.js';

const prisma = new PrismaClient();

/** id ที่อยู่ในช่วง INT4 แต่ไม่มีแถวไหนใช้ — ให้ request ที่ผ่านด่านไปตกที่ "ไม่พบ" แทนการแก้ของจริง */
const NONEXISTENT_ID = 2_147_483_000;
/** เกิน INT4 — เคยทำให้ Prisma พังเป็น 500 (ADR-055 ข้อ 2) */
const OVERFLOW_ID = '99999999999';

type Level = 'public' | 'member' | 'admin';
const LEVEL_ICON: Record<Level, string> = { public: '🌐', member: '🔒', admin: '🛡️' };

interface Access {
  level: Level;
  /** path ที่แทน param แล้ว (ไม่มี `/api/v1`) */
  path: string;
  body?: unknown;
  /** status ที่คนผ่านด่านต้องได้ — ไม่ระบุ = อะไรก็ได้ที่ไม่ใช่ 401/403/500 */
  passStatus?: number;
  /** ไม่ยิงด้วยสิทธิ์ที่ผ่านด่าน เพราะมีผลข้างเคียงจริงหรือกินโควตา rate limit — บอกเหตุผลไว้ */
  skipPass?: string;
  /** limiter วางอยู่ **ก่อน** ด่านสิทธิ์ — ยิงแค่สองแบบพอ ไม่งั้นรันซ้ำแล้วติด 429 แทน 401 */
  limitedBeforeGate?: true;
}

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
  headers: Headers;
}

async function call(
  method: string,
  url: string,
  opts: { auth?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.auth) headers.authorization = opts.auth;
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers['content-type'] ??= 'application/json';
  } else if (opts.body !== undefined && method !== 'GET') {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${API}${url}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ไม่ใช่ JSON — ตัวเช็คที่สนใจจะดู `text` เอง
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const codeOf = (res: Res): string | undefined => res.body?.error?.code;

/** fetch ทำ `..` ใน URL ให้เรียบร้อยก่อนส่ง — ทดสอบ path traversal ต้องยิงพาธดิบเอง */
function rawGet(rawPath: string): Promise<{ status: number; text: string }> {
  const url = new URL(SERVER_URL);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: url.hostname, port: url.port, path: rawPath }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------ 1. รายชื่อ endpoint

interface ExpressLayer {
  name: string;
  regexp: RegExp;
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: ExpressLayer[] };
}

/** Express 4 เก็บ path ของ `router.use('/auth', …)` ไว้เป็น regexp อย่างเดียว เช่น `^\/auth\/?(?=\/|$)` */
function mountPathOf(layer: ExpressLayer): string {
  const match = /^\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  return match ? `/${match[1]!.replace(/\\\//g, '/')}` : '';
}

function listRoutes(stack: ExpressLayer[], prefix = ''): string[] {
  const routes: string[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const fullPath = `${prefix}${layer.route.path}`.replace(/\/$/, '') || '/';
      for (const method of Object.keys(layer.route.methods)) {
        routes.push(`${method.toUpperCase()} ${fullPath}`);
      }
    } else if (layer.name === 'router' && layer.handle.stack) {
      routes.push(...listRoutes(layer.handle.stack, prefix + mountPathOf(layer)));
    }
  }
  return routes;
}

function implementedRoutes(): string[] {
  const app = createApp() as unknown as { _router: { stack: ExpressLayer[] } };
  return listRoutes(app._router.stack)
    .filter((route) => route.split(' ')[1]!.startsWith(API_BASE_PATH))
    .map((route) => {
      const [method, fullPath] = route.split(' ');
      return `${method} ${fullPath!.slice(API_BASE_PATH.length) || '/'}`;
    });
}

/** ตารางสิทธิ์ใน api-contract.md — `null` = หาไฟล์ไม่เจอ (เช็กเอาต์มาแค่ backend) */
function documentedRoutes(): Map<string, Level> | null {
  const file = path.resolve(process.cwd(), '../docs/api-contract.md');
  if (!existsSync(file)) return null;

  const levels: Record<string, Level> = { '🌐': 'public', '🔒': 'member', '🛡': 'admin' };
  const routes = new Map<string, Level>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\|\s*(GET|POST|PATCH|PUT|DELETE)\s*\|\s*`([^`]+)`\s*\|\s*(🌐|🔒|🛡)️?\s*\|/u.exec(line);
    if (m) routes.set(`${m[1]} ${m[2]!.split('?')[0]}`, levels[m[3]!]!);
  }
  return routes;
}

// ------------------------------------------------------------------ ตั้งฉาก

interface Fixture {
  admin: { userId: number; username: string };
  members: { userId: number; username: string }[];
  deleted: { userId: number; username: string };
  matchId: number;
  multiplayerMatchId: number;
  newsId: number;
}

async function createDeletedUser(): Promise<{ userId: number; username: string }> {
  const stamp = Date.now();
  const user = await prisma.user.create({
    data: { username: `sec_probe_${stamp}`, email: `sec_probe_${stamp}@security.local` },
  });
  await prisma.rating.createMany({
    data: [CubeType.CUBE_2X2X2, CubeType.CUBE_3X3X3, CubeType.PYRAMINX, CubeType.PYRAMORPHIX].map(
      (cubeType) => ({ userId: user.userId, cubeType, eloRating: 1000 }),
    ),
  });
  // หน้าตาเหมือนบัญชีที่เจ้าของกดลบเองทุกอย่าง (auth.service.ts `deleteAccount()` · ADR-008)
  return prisma.user.update({
    where: { userId: user.userId },
    data: {
      deletedAt: new Date(),
      status: UserStatus.SUSPENDED,
      username: `deleted_user_${user.userId}`,
      email: `deleted_${user.userId}@cubeduel.local`,
    },
    select: { userId: true, username: true },
  });
}

async function removeUser(userId: number): Promise<void> {
  await prisma.rating.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { userId } });
}

async function loadFixture(): Promise<Fixture> {
  const admin = await prisma.user.findFirst({
    where: { role: UserRole.ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
    select: { userId: true, username: true },
  });
  const members = await prisma.user.findMany({
    where: {
      role: UserRole.MEMBER,
      status: UserStatus.ACTIVE,
      deletedAt: null,
      username: { in: ['somchai', 'malee', 'nattapong', 'pimchanok', 'thanawat', 'kanyarat'] },
    },
    select: { userId: true, username: true },
    orderBy: { userId: 'asc' },
    take: 3,
  });
  if (!admin || members.length < 3) {
    throw new Error('ต้องมีแอดมิน 1 คน + สมาชิกที่ใช้งานได้ 3 คนจาก npm run seed');
  }

  const [match, multi, news] = await Promise.all([
    prisma.match.findFirst({ select: { matchId: true } }),
    prisma.multiplayerMatch.findFirst({ select: { multiplayerMatchId: true } }),
    prisma.news.findFirst({ select: { newsId: true } }),
  ]);
  return {
    admin,
    members,
    deleted: await createDeletedUser(),
    matchId: match?.matchId ?? NONEXISTENT_ID,
    multiplayerMatchId: multi?.multiplayerMatchId ?? NONEXISTENT_ID,
    newsId: news?.newsId ?? NONEXISTENT_ID,
  };
}

/**
 * ระดับสิทธิ์ + request ตัวอย่างของทุก endpoint — **เพิ่ม endpoint ใหม่แล้วต้องมาเพิ่มที่นี่**
 * ไม่งั้นข้อ 1 ไม่ผ่าน (นั่นคือจุดประสงค์: ไม่มี endpoint ไหนหลุดจากการตรวจสิทธิ์เงียบ ๆ)
 */
function access(f: Fixture): Record<string, Access> {
  const me = f.members[0]!.userId;
  const ghost = NONEXISTENT_ID;
  return {
    'GET /health': { level: 'public', path: '/health', passStatus: 200 },

    'POST /auth/register': {
      level: 'public',
      path: '/auth/register',
      skipPass: 'limiter 5 ครั้ง/ชั่วโมงอยู่ก่อน validation — smoke อื่นทดสอบการสมัครแล้ว',
    },
    'POST /auth/login': { level: 'public', path: '/auth/login', body: {}, passStatus: 400 },
    // ไม่ต้องใช้ access token แต่ต้องมี refresh token — ไม่มีก็ 401 เป็นเรื่องถูกต้อง
    'POST /auth/refresh': { level: 'public', path: '/auth/refresh', body: {}, passStatus: 401 },
    'POST /auth/logout': { level: 'member', path: '/auth/logout', body: {}, limitedBeforeGate: true },
    'POST /auth/logout-all': {
      level: 'member',
      path: '/auth/logout-all',
      limitedBeforeGate: true,
      skipPass: 'เพิกถอนเซสชันจริงของบัญชี seed',
    },
    'POST /auth/change-password': {
      level: 'member',
      path: '/auth/change-password',
      body: {},
      passStatus: 400,
      limitedBeforeGate: true,
    },
    'DELETE /auth/account': {
      level: 'member',
      path: '/auth/account',
      limitedBeforeGate: true,
      skipPass: 'ลบบัญชีจริง',
    },

    'GET /users/me': { level: 'member', path: '/users/me', passStatus: 200 },
    'PATCH /users/me': { level: 'member', path: '/users/me', body: {}, passStatus: 400 },
    'GET /users/:userId/stats': {
      level: 'public',
      path: `/users/${me}/stats?cubeType=3x3x3`,
      passStatus: 200,
    },
    'GET /users/:userId/matches': { level: 'public', path: `/users/${me}/matches`, passStatus: 200 },
    'GET /users/:userId/ratings': { level: 'public', path: `/users/${me}/ratings`, passStatus: 200 },
    'GET /users/:userId': { level: 'public', path: `/users/${me}`, passStatus: 200 },
    'GET /matches/:matchId': { level: 'public', path: `/matches/${f.matchId}` },
    'GET /multiplayer-matches/:multiplayerMatchId': {
      level: 'public',
      path: `/multiplayer-matches/${f.multiplayerMatchId}`,
    },
    'GET /leaderboard': { level: 'public', path: '/leaderboard?cubeType=3x3x3', passStatus: 200 },
    'GET /scramble': { level: 'member', path: '/scramble?cubeType=2x2x2', passStatus: 200 },
    'GET /news': { level: 'public', path: '/news', passStatus: 200 },
    'GET /news/:newsId': { level: 'public', path: `/news/${f.newsId}` },
    // reportLimiter อยู่หลัง requireAuth — 429 จึงแปลว่าผ่านด่านสิทธิ์มาแล้วเหมือนกัน
    'POST /reports': { level: 'member', path: '/reports', body: {} },

    'POST /admin/news': { level: 'admin', path: '/admin/news', body: {}, passStatus: 400 },
    'PATCH /admin/news/:newsId': { level: 'admin', path: `/admin/news/${ghost}`, body: {} },
    'DELETE /admin/news/:newsId': { level: 'admin', path: `/admin/news/${ghost}`, passStatus: 404 },
    'GET /admin/dashboard': { level: 'admin', path: '/admin/dashboard', passStatus: 200 },
    'GET /admin/users': { level: 'admin', path: '/admin/users', passStatus: 200 },
    'PATCH /admin/users/:userId/status': {
      level: 'admin',
      path: `/admin/users/${ghost}/status`,
      body: {},
      passStatus: 400,
    },
    'PATCH /admin/users/:userId/rating': {
      level: 'admin',
      path: `/admin/users/${ghost}/rating`,
      body: {},
      passStatus: 400,
    },
    'GET /admin/reports': { level: 'admin', path: '/admin/reports', passStatus: 200 },
    'PATCH /admin/reports/:reportId': {
      level: 'admin',
      path: `/admin/reports/${ghost}`,
      body: {},
      passStatus: 400,
    },
    'GET /admin/matches/flagged': { level: 'admin', path: '/admin/matches/flagged', passStatus: 200 },
    'GET /admin/matches/flagged/:flagId': {
      level: 'admin',
      path: `/admin/matches/flagged/${ghost}`,
      passStatus: 404,
    },
    'PATCH /admin/matches/flagged/:flagId': {
      level: 'admin',
      path: `/admin/matches/flagged/${ghost}`,
      body: {},
      passStatus: 400,
    },
  };
}

// ------------------------------------------------------------------ token

interface Credential {
  label: string;
  /** ค่า header `Authorization` ทั้งก้อน · `undefined` = ไม่ส่ง header เลย */
  header: string | undefined;
  status: number;
  code: string;
}

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** ทุกแบบต้องโดนปฏิเสธ — ตัวที่อ้างสิทธิ์ทั้งหมดอ้างเป็นแอดมิน เพื่อให้เห็นชัดว่าไม่ได้อะไรเลย */
function forgedCredentials(f: Fixture): Credential[] {
  const claim = { sub: f.admin.userId, username: f.admin.username, role: 'admin' };
  const unauth = (label: string, header: string | undefined): Credential => ({
    label,
    header,
    status: 401,
    code: 'E_UNAUTHENTICATED',
  });
  return [
    unauth('ไม่มี token', undefined),
    unauth('ไม่ใช่ JWT', 'Bearer not-a-jwt'),
    unauth('scheme ผิด (Token …)', `Token ${signAccessToken(claim as never)}`),
    unauth('alg: none ไม่มีลายเซ็น', `Bearer ${b64({ alg: 'none', typ: 'JWT' })}.${b64(claim)}.`),
    unauth('เซ็นด้วย secret ที่ผิด', `Bearer ${jwt.sign(claim, 'not-the-real-secret')}`),
    unauth(
      'เซ็นด้วย HS512 (secret ถูก อัลกอริทึมผิด)',
      `Bearer ${jwt.sign(claim, env.jwt.accessSecret, { algorithm: 'HS512' })}`,
    ),
    unauth(
      'หมดอายุแล้ว',
      `Bearer ${jwt.sign({ ...claim, exp: Math.floor(Date.now() / 1000) - 60 }, env.jwt.accessSecret)}`,
    ),
    unauth('เอา refresh token มาใช้แทน', `Bearer ${signRefreshToken({ sub: f.admin.userId, jti: 'x' })}`),
    unauth(
      'userId ที่ไม่มีอยู่จริง',
      `Bearer ${signAccessToken({ sub: NONEXISTENT_ID, username: 'ghost', role: 'admin' })}`,
    ),
    {
      label: 'บัญชีที่ถูกลบแล้ว',
      header: `Bearer ${signAccessToken({ sub: f.deleted.userId, username: f.deleted.username, role: 'member' })}`,
      status: 403,
      code: 'E_ACCOUNT_SUSPENDED',
    },
  ];
}

const bearer = (user: { userId: number; username: string }, role: 'member' | 'admin') =>
  `Bearer ${signAccessToken({ sub: user.userId, username: user.username, role })}`;

// ------------------------------------------------------------------ 2. ด่านสิทธิ์

const isEndpointMissing = (res: Res) =>
  res.status === 404 && String(res.body?.error?.message ?? '').startsWith('ไม่พบ endpoint');

async function gateCheck(key: string, a: Access, f: Fixture): Promise<void> {
  const [method] = key.split(' ') as [string];
  const problems: string[] = [];
  let skippedByLimit = 0;

  const expectDenied = async (cred: Credential) => {
    const res = await call(method, a.path, { auth: cred.header, body: a.body });
    if (res.status === 429 && a.limitedBeforeGate) return void skippedByLimit++;
    if (res.status !== cred.status || codeOf(res) !== cred.code) {
      problems.push(`${cred.label} → ${res.status} ${codeOf(res) ?? ''}`);
    }
  };
  const expectPassed = async (label: string, auth: string | undefined) => {
    const res = await call(method, a.path, { auth, body: a.body });
    const ok =
      a.passStatus !== undefined
        ? res.status === a.passStatus
        : res.status !== 401 && res.status !== 403 && res.status < 500 && !isEndpointMissing(res);
    if (!ok) problems.push(`${label} ควรผ่านด่าน แต่ได้ ${res.status} ${codeOf(res) ?? ''}`);
    return res;
  };

  const forged = forgedCredentials(f);
  const memberAuth = bearer(f.members[0]!, 'member');
  let passNote = '';

  if (a.level === 'public') {
    if (!a.skipPass) await expectPassed('ไม่ล็อกอิน', undefined);
  } else {
    // endpoint ที่ limiter อยู่ก่อนด่าน: ยิงแค่สองแบบ ไม่งั้นรันซ้ำภายใน 15 นาทีแล้วเจอ 429 แทน 401
    for (const cred of a.limitedBeforeGate ? forged.slice(0, 2) : forged) await expectDenied(cred);

    if (a.level === 'admin') {
      await expectDenied({ label: 'สมาชิกทั่วไป', header: memberAuth, status: 403, code: 'E_FORBIDDEN' });
      // ลายเซ็นถูกต้องทุกอย่าง แต่ role ใน token โกหก — server ต้องเชื่อ DB ไม่ใช่ token
      await expectDenied({
        label: 'สมาชิกที่ token อ้างว่าเป็น admin',
        header: bearer(f.members[0]!, 'admin'),
        status: 403,
        code: 'E_FORBIDDEN',
      });
      if (!a.skipPass) await expectPassed('แอดมิน', bearer(f.admin, 'admin'));
    } else if (!a.skipPass) {
      await expectPassed('สมาชิก', memberAuth);
    }
  }
  if (a.skipPass) passNote = ` · ไม่ยิงฝั่งที่ผ่านด่าน (${a.skipPass})`;
  if (skippedByLimit) passNote += ` · ⚠️ ติด rate limit ${skippedByLimit} ครั้ง รอ 15 นาทีแล้วรันใหม่`;

  check(`${LEVEL_ICON[a.level]} ${key}${passNote}`, problems.length === 0, problems);
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  const f = await loadFixture();
  const table = access(f);
  const member = f.members[0]!;
  const memberAuth = bearer(member, 'member');
  const adminAuth = bearer(f.admin, 'admin');

  try {
    console.log('\n── 1. รายชื่อ endpoint: ของจริงใน Express ↔ ตารางสิทธิ์ของสคริปต์ ↔ api-contract.md');
    const routes = implementedRoutes();
    check(`อ่านรายชื่อ endpoint จาก router ของ Express ได้ (${routes.length} ตัว)`, routes.length >= 30);
    const unlisted = routes.filter((r) => !(r in table));
    check('ทุก endpoint ที่มีอยู่จริงมีระดับสิทธิ์ในตารางของสคริปต์', unlisted.length === 0, unlisted);
    const stale = Object.keys(table).filter((r) => !routes.includes(r));
    check('ตารางของสคริปต์ไม่มี endpoint ที่ไม่มีอยู่จริง', stale.length === 0, stale);

    const docs = documentedRoutes();
    if (!docs) {
      console.log('  ⏭️  ไม่พบ ../docs/api-contract.md — ข้ามการเทียบกับเอกสาร');
    } else {
      const undocumented = routes.filter((r) => !docs.has(r));
      check('ทุก endpoint ที่มีอยู่จริงอยู่ในตารางของ api-contract.md', undocumented.length === 0, undocumented);
      const mismatch = routes
        .filter((r) => docs.has(r) && table[r] && docs.get(r) !== table[r]!.level)
        .map((r) => `${r}: เอกสาร ${LEVEL_ICON[docs.get(r)!]} · สคริปต์ ${LEVEL_ICON[table[r]!.level]}`);
      check('ระดับสิทธิ์ตรงกับเอกสารทุกตัว', mismatch.length === 0, mismatch);
      const notYet = [...docs.keys()].filter((r) => !routes.includes(r));
      if (notYet.length) console.log(`  ⏭️  อยู่ในเอกสารแต่ยังไม่ได้ทำ: ${notYet.join(' · ')}`);
    }

    console.log('\n── 2. ด่านสิทธิ์ของทุก endpoint (token ปลอม 10 แบบ · สมาชิก · สมาชิกที่อ้าง role admin · แอดมิน)');
    for (const key of routes.filter((r) => r in table)) await gateCheck(key, table[key]!, f);

    console.log('\n── 3. ข้อมูลส่วนตัวไม่หลุด');
    const secretKeys = /"(email|passwordHash|password_hash|tokenHash|refreshToken|moveLog)"/;
    const publicReads = [
      ...Object.entries(table)
        .filter(([key, a]) => a.level === 'public' && key.startsWith('GET '))
        .map(([, a]) => a.path),
      '/leaderboard?cubeType=3x3x3&scope=weekly',
      `/users/${f.admin.userId}`,
    ];
    const leaks: string[] = [];
    for (const url of publicReads) {
      const res = await call('GET', url);
      const hit = secretKeys.exec(res.text);
      if (hit) leaks.push(`${url} มี "${hit[1]}"`);
    }
    check(`endpoint สาธารณะ ${publicReads.length} ตัวไม่มี email / hash / token / move log`, leaks.length === 0, leaks);

    const self = await call('GET', '/users/me', { auth: memberAuth });
    check('GET /users/me ของตัวเองยังเห็น email ตัวเอง', self.body?.data?.email !== undefined);

    const deletedPaths = ['', '/stats?cubeType=3x3x3', '/matches', '/ratings'].map(
      (suffix) => `/users/${f.deleted.userId}${suffix}`,
    );
    const deletedVisible: string[] = [];
    for (const url of deletedPaths) {
      const res = await call('GET', url);
      if (res.status !== 404) deletedVisible.push(`${url} → ${res.status}`);
    }
    check('บัญชีที่ถูกลบแล้วถือว่าไม่มีอยู่ทุก endpoint ที่มี :userId (404)', deletedVisible.length === 0, deletedVisible);

    console.log('\n── 4. input ประสงค์ร้าย — ต้องได้ 4xx เสมอ ไม่มี 500');
    const expect400 = async (label: string, method: string, url: string, opts: Parameters<typeof call>[2] = {}) => {
      const res = await call(method, url, opts);
      check(`${label} → 400`, res.status === 400 && codeOf(res) === 'E_VALIDATION', `${res.status} ${res.text.slice(0, 160)}`);
      return res;
    };
    await expect400("SQL ใน enum: cubeType=3x3x3' OR '1'='1", 'GET', `/leaderboard?cubeType=${encodeURIComponent("3x3x3' OR '1'='1")}`);
    await expect400('SQL ใน sortBy: elo;DROP TABLE "User"--', 'GET', `/leaderboard?cubeType=3x3x3&scope=weekly&sortBy=${encodeURIComponent('elo;DROP TABLE "User"--')}`);
    await expect400('SQL ใน path: /users/1 OR 1=1', 'GET', `/users/${encodeURIComponent('1 OR 1=1')}`);
    await expect400("SQL ในตัวกรอง: cubeType=3x3x3'--", 'GET', `/users/${member.userId}/matches?cubeType=${encodeURIComponent("3x3x3'--")}`);

    const injectedSearch = await call('GET', `/admin/users?q=${encodeURIComponent("' OR '1'='1")}`, { auth: adminAuth });
    check(
      "ช่องค้นหาของแอดมิน q=' OR '1'='1 ถูกส่งเป็นพารามิเตอร์ (200 · ไม่เจอใคร)",
      injectedSearch.status === 200 && injectedSearch.body?.data?.length === 0,
      `${injectedSearch.status} พบ ${injectedSearch.body?.data?.length}`,
    );
    const percentSearch = await call('GET', `/admin/users?q=${encodeURIComponent('%')}`, { auth: adminAuth });
    check(
      'ค้นหาด้วย % ไม่กลายเป็น wildcard (username มี % ไม่ได้อยู่แล้ว ต้องไม่เจอใคร)',
      percentSearch.status === 200 && percentSearch.body?.data?.length === 0,
      `${percentSearch.status} พบ ${percentSearch.body?.data?.length}`,
    );

    for (const url of [
      `/users/${OVERFLOW_ID}`,
      `/users/${OVERFLOW_ID}/stats?cubeType=3x3x3`,
      `/users/${OVERFLOW_ID}/matches`,
      `/users/${OVERFLOW_ID}/ratings`,
      `/matches/${OVERFLOW_ID}`,
      `/multiplayer-matches/${OVERFLOW_ID}`,
      `/news/${OVERFLOW_ID}`,
    ]) {
      await expect400(`id เกิน INT4: ${url}`, 'GET', url);
    }
    await expect400(`id เกิน INT4 ในหน้าแอดมิน: /admin/matches/flagged/${OVERFLOW_ID}`, 'GET', `/admin/matches/flagged/${OVERFLOW_ID}`, { auth: adminAuth });
    await expect400('id เกิน INT4 ใน body: POST /reports', 'POST', '/reports', {
      auth: memberAuth,
      body: { reportedUserId: Number(OVERFLOW_ID), reason: 'ทดสอบ id ที่ใหญ่เกินคอลัมน์' },
    });

    await expect400('JSON พัง', 'POST', '/auth/login', { rawBody: '{"identifier": "admin",' });
    await expect400('body ใหญ่เกิน 1 MB', 'POST', '/auth/login', {
      body: { identifier: 'x', password: 'a'.repeat(1_100_000) },
    });
    await expect400('object แทน string (NoSQL-style)', 'PATCH', '/users/me', {
      auth: memberAuth,
      body: { nickname: { $ne: null } },
    });
    await expect400('แอบแก้ role ทาง PATCH /users/me', 'PATCH', '/users/me', {
      auth: memberAuth,
      body: { role: 'admin' },
    });
    await expect400('แอบแก้ userId ของคนอื่นทาง PATCH /users/me', 'PATCH', '/users/me', {
      auth: memberAuth,
      body: { userId: f.admin.userId, cubeSkin: 'neon' },
    });
    await expect400('prototype pollution: {"__proto__":{"role":"admin"}}', 'PATCH', '/users/me', {
      auth: memberAuth,
      rawBody: '{"__proto__":{"role":"admin"},"cubeSkin":"classic"}',
    });
    const stillMember = await call('GET', '/users/me', { auth: memberAuth });
    check('หลังโดนยิงทั้งหมดแล้วสมาชิกยังเป็น member', stillMember.body?.data?.role === 'member', stillMember.body?.data?.role);

    const reflected = await call('GET', `/<script>alert(1)</script>`);
    check(
      'path ที่มี <script> ถูกสะท้อนกลับเป็น JSON ไม่ใช่ HTML',
      reflected.status === 404 && (reflected.headers.get('content-type') ?? '').includes('application/json'),
      reflected.headers.get('content-type'),
    );

    console.log('\n── 5. header · CORS · /uploads');
    const health = await call('GET', '/health', { headers: { origin: 'https://evil.example' } });
    check('ไม่ประกาศว่าเป็น Express (ไม่มี X-Powered-By)', !health.headers.has('x-powered-by'));
    check('X-Content-Type-Options: nosniff', health.headers.get('x-content-type-options') === 'nosniff');
    check('X-Frame-Options: DENY', health.headers.get('x-frame-options') === 'DENY');
    check(
      'CORS ไม่อนุญาตโดเมนแปลกหน้า',
      health.headers.get('access-control-allow-origin') !== 'https://evil.example',
      health.headers.get('access-control-allow-origin'),
    );
    const allowed = await call('GET', '/health', { headers: { origin: env.corsOrigin } });
    check(`CORS อนุญาตเฉพาะ ${env.corsOrigin}`, allowed.headers.get('access-control-allow-origin') === env.corsOrigin);

    for (const raw of ['/uploads/../.env', '/uploads/%2e%2e/.env', '/uploads/news/..%2f..%2f.env', '/uploads/..%5c.env', '/uploads/']) {
      const res = await rawGet(raw);
      check(`path traversal ${raw} ไม่ได้อะไรกลับไป (${res.status})`, res.status !== 200 && !res.text.includes('JWT_'));
    }

    await socketChecks(f);
  } finally {
    await removeUser(f.deleted.userId);
  }
  return summary();
}

// ------------------------------------------------------------------ 6. socket

async function handshake(token: string | undefined): Promise<{ ok: boolean; code?: string }> {
  const socket = io(SERVER_URL, {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    reconnection: false,
  });
  return new Promise((resolve) => {
    socket.once('connect', () => {
      socket.disconnect();
      resolve({ ok: true });
    });
    socket.once('connect_error', (err: Error & { data?: { code?: string } }) => {
      socket.close();
      resolve({ ok: false, code: err.data?.code });
    });
  });
}

async function socketChecks(f: Fixture): Promise<void> {
  console.log('\n── 6. socket');
  for (const cred of forgedCredentials(f)) {
    // handshake รับ token ดิบหรือขึ้นต้นด้วย `Bearer ` (sockets/auth.ts) — ตัดเฉพาะ `Bearer `
    // เคส "scheme ผิด" จึงส่ง `Token eyJ…` ไปทั้งก้อน ซึ่งต้องโดนปฏิเสธ
    const token = cred.header?.replace(/^Bearer\s+/, '');
    const result = await handshake(token);
    check(
      `handshake: ${cred.label} → ${cred.code}`,
      !result.ok && result.code === cred.code,
      result,
    );
  }

  const [hostUser, guestUser, watcherUser] = f.members as [Fixture['members'][0], Fixture['members'][0], Fixture['members'][0]];
  const tokenOf = (u: { userId: number; username: string }) =>
    signAccessToken({ sub: u.userId, username: u.username, role: 'member' });
  const sockets: Socket[] = [];
  try {
    const host = await connect(tokenOf(hostUser));
    const guest = await connect(tokenOf(guestUser));
    const watcher = await connect(tokenOf(watcherUser));
    sockets.push(host, guest, watcher);

    // userId ใน payload ต้องไม่มีผลอะไร — ผู้สร้างห้องคือเจ้าของ token เสมอ (CLAUDE.md ข้อ 8)
    const created = await emit<{ roomId: number; roomCode: string }>(host, 'room:create', {
      cubeType: '2x2x2',
      kind: 'custom',
      maxPlayers: 2,
      userId: f.admin.userId,
    });
    if (!created.ok) throw new Error(`สร้างห้องไม่ได้: ${created.error.code}`);

    const watched = await emit<{ snapshot: { players: { userId: number }[] } }>(watcher, 'room:join', {
      roomCode: created.data.roomCode,
      as: 'spectator',
    });
    const seated = watched.ok ? watched.data.snapshot.players.map((p) => p.userId) : [];
    check(
      'userId ใน payload ของ room:create ถูกเมิน — คนที่นั่งคือเจ้าของ token',
      seated.length === 1 && seated[0] === hostUser.userId,
      seated,
    );

    const moveError = waitFor<{ code: string }>(watcher, 'error', 3_000);
    watcher.emit('solve:move', { seq: 1, move: 'R', clientTs: Date.now() });
    const moveResult = await moveError;
    check('ผู้ชมส่ง solve:move ไม่ได้ (E_INVALID_STATE)', moveResult?.code === 'E_INVALID_STATE', moveResult);

    const watcherStart = await emit(watcher, 'room:start', {});
    check(
      'ผู้ชมกดเริ่มแข่งไม่ได้ (E_NOT_HOST)',
      !watcherStart.ok && watcherStart.error.code === 'E_NOT_HOST',
      watcherStart,
    );

    await emit(guest, 'room:join', { roomCode: created.data.roomCode, as: 'player' });
    const guestStart = await emit(guest, 'room:start', {});
    check(
      'ผู้เล่นที่ไม่ใช่ host กดเริ่มไม่ได้ (E_NOT_HOST)',
      !guestStart.ok && guestStart.error.code === 'E_NOT_HOST',
      guestStart,
    );

    if (env.allowTestCompetitiveRoom) {
      console.log('  ⏭️  เครื่องนี้เปิด ALLOW_TEST_COMPETITIVE_ROOM=1 — ข้ามเช็คว่าสร้างห้องแข่งขันเองไม่ได้');
    } else {
      const competitive = await emit(host, 'room:create', { cubeType: '2x2x2', kind: 'competitive', maxPlayers: 2 });
      check(
        'สร้างห้องแข่งขัน (ปรับ Elo) เองด้วยรหัสห้องไม่ได้',
        !competitive.ok && competitive.error.code === 'E_VALIDATION',
        competitive,
      );
    }

    if (process.env.DISABLE_RATE_LIMIT === 'true') {
      console.log('  ⏭️  เครื่องนี้ตั้ง DISABLE_RATE_LIMIT=true — ข้ามเช็ค rate limit ของ socket');
    } else {
      const burst = await Promise.all(
        Array.from({ length: 40 }, () => emit(host, 'net:ping', { clientTs: Date.now() })),
      );
      const limited = burst.filter((ack) => !ack.ok && ack.error.code === 'E_RATE_LIMITED').length;
      check(`ยิง net:ping 40 ครั้งรวดโดน E_RATE_LIMITED (${limited} ครั้ง)`, limited > 0);
    }
  } finally {
    await Promise.all(sockets.map((s) => emit(s, 'room:leave', {})));
    for (const s of sockets) s.disconnect();
  }
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error('[security] ล้มเหลว:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
