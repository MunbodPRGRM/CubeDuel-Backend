/**
 * สโมคเทสรีเซ็ตรหัสผ่าน (เฟส 2 — ADR-057)
 *
 * ต้องรัน `npm run dev` ไว้ก่อน (โหมด `EMAIL_TRANSPORT=console` — อีเมลโผล่ใน log ของ server ไม่ได้ส่งจริง)
 * ควรเปิด server ด้วย `DISABLE_RATE_LIMIT=true` เพราะสคริปต์ล็อกอินหลายรอบและขอลิงก์หลายครั้ง
 *
 * token ดิบอยู่ในอีเมลที่เดียว DB เก็บแค่ hash → สคริปต์อ่านลิงก์จากอีเมลไม่ได้
 * จึงตรวจ `forgot-password` จากแถวที่เกิดใน DB และ **สร้าง token ที่รู้ค่าลง DB เอง** เพื่อทดสอบ `reset-password`
 * บัญชีทดสอบสร้างใหม่ทุกรอบแล้วลบทิ้งตอนจบ (เพดาน 3 ครั้ง/ชั่วโมงต่ออีเมลจึงไม่ค้างข้ามรอบ)
 *
 *   npm run smoke:reset
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';
import { generateOpaqueToken, hashToken } from '../src/lib/tokens.js';
import { API, check, summary } from './smoke-helpers.js';

const prisma = new PrismaClient();

const OLD_PASSWORD = 'OldPass123';
const NEW_PASSWORD = 'NewPass456';
const TTL_MS = 30 * 60_000;

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function post(path: string, body: unknown): Promise<Res> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tokenRows(userId: number) {
  return prisma.passwordResetToken.findMany({ where: { userId }, orderBy: { tokenId: 'asc' } });
}

/** `forgot-password` ทำงานหลังตอบ (ADR-057 ข้อ 1) — รอจนแถวใน DB ครบตามที่คาด หรือหมดเวลา */
async function waitForRows(userId: number, count: number, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  let rows = await tokenRows(userId);
  while (rows.length < count && Date.now() < until) {
    await sleep(100);
    rows = await tokenRows(userId);
  }
  return rows;
}

/** สร้าง token ที่รู้ค่าดิบลง DB ตรง ๆ — ทางเดียวที่สโมคจะได้ token ไปยิง `reset-password` */
async function insertToken(userId: number, expiresAt = new Date(Date.now() + TTL_MS)) {
  const token = generateOpaqueToken();
  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });
  return token;
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const user = await prisma.user.create({
    data: {
      username: `reset_probe_${stamp}`,
      email: `reset_probe_${stamp}@smoke.local`,
      passwordHash: await hashPassword(OLD_PASSWORD),
    },
  });
  const { userId, username, email } = user;
  console.log(`\nบัญชีทดสอบ: ${username} (#${userId})\n`);

  try {
    console.log('1) forgot-password ตอบเหมือนกันทุกกรณี');
    const unknown = await post('/auth/forgot-password', { email: `nobody_${stamp}@smoke.local` });
    check('อีเมลที่ไม่มีบัญชี → 200 sent', unknown.status === 200 && unknown.body.data?.sent === true, unknown);
    const known = await post('/auth/forgot-password', { email: `  ${email.toUpperCase()} ` });
    check(
      'อีเมลที่มีบัญชี (พิมพ์ใหญ่ + เว้นวรรค) → response เหมือนกันเป๊ะ',
      known.status === 200 && JSON.stringify(known.body) === JSON.stringify(unknown.body),
      known,
    );
    const malformed = await post('/auth/forgot-password', { email: 'not-an-email' });
    check('อีเมลรูปแบบผิด → 400', malformed.status === 400 && malformed.body.error?.code === 'E_VALIDATION', malformed);

    let rows = await waitForRows(userId, 1);
    check('เกิด token 1 แถวของบัญชีนี้', rows.length === 1, rows.length);
    const ttl = rows[0] ? rows[0].expiresAt.getTime() - rows[0].createdAt.getTime() : 0;
    check('อายุ 30 นาที', Math.abs(ttl - TTL_MS) < 5_000, ttl);
    check('DB เก็บ hash ไม่ใช่ token ดิบ (SHA-256 = 64 ตัว hex)', /^[0-9a-f]{64}$/.test(rows[0]?.tokenHash ?? ''));

    console.log('\n2) ขอใหม่แล้วลิงก์เก่าเป็นโมฆะ');
    await post('/auth/forgot-password', { email });
    rows = await waitForRows(userId, 2);
    check('มี 2 แถว', rows.length === 2, rows.length);
    check('ใบแรกถูกปิด (used_at มีค่า)', rows[0]?.usedAt !== null, rows[0]);
    check('ใบใหม่ยังใช้ได้', rows[1]?.usedAt === null, rows[1]);

    console.log('\n3) เพดาน 3 ครั้ง/ชั่วโมงต่ออีเมล — เกินแล้วเงียบ');
    await post('/auth/forgot-password', { email });
    rows = await waitForRows(userId, 3);
    check('ครั้งที่ 3 ยังได้ token', rows.length === 3, rows.length);
    const fourth = await post('/auth/forgot-password', { email });
    check('ครั้งที่ 4 ยังตอบ 200 (ห้ามบอกว่าอีเมลนี้มีบัญชี)', fourth.status === 200, fourth);
    await sleep(1_500);
    rows = await tokenRows(userId);
    check('ครั้งที่ 4 ไม่เกิด token ใหม่', rows.length === 3, rows.length);

    console.log('\n4) reset-password ด้วย token ที่ไม่มีอยู่');
    const bogus = await post('/auth/reset-password', { token: 'nope', newPassword: NEW_PASSWORD });
    check('→ 400 พร้อม fields.token', bogus.status === 400 && typeof bogus.body.error?.fields?.token === 'string', bogus);
    const noToken = await post('/auth/reset-password', { newPassword: NEW_PASSWORD });
    check('ไม่ส่ง token มาเลย → 400', noToken.status === 400, noToken);

    console.log('\n5) token ใช้ได้ แต่รหัสผ่านใหม่ไม่ผ่านกติกา');
    const good = await insertToken(userId);
    const weak = await post('/auth/reset-password', { token: good, newPassword: 'short' });
    check('→ 400 พร้อม fields.newPassword', weak.status === 400 && typeof weak.body.error?.fields?.newPassword === 'string', weak);
    const stillOpen = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(good) } });
    check('token ยังไม่ถูกใช้ไป', stillOpen?.usedAt === null, stillOpen);

    console.log('\n6) รีเซ็ตสำเร็จ');
    const before = await post('/auth/login', { identifier: username, password: OLD_PASSWORD });
    check('ล็อกอินด้วยรหัสเดิมได้ก่อนรีเซ็ต', before.status === 200, before.status);
    const oldRefresh: string | undefined = before.body.data?.refreshToken;

    const reset = await post('/auth/reset-password', { token: good, newPassword: NEW_PASSWORD });
    check('→ 200 passwordReset', reset.status === 200 && reset.body.data?.passwordReset === true, reset);
    const withOld = await post('/auth/login', { identifier: username, password: OLD_PASSWORD });
    check('รหัสเดิมใช้ไม่ได้แล้ว', withOld.status === 401, withOld.status);
    const withNew = await post('/auth/login', { identifier: username, password: NEW_PASSWORD });
    check('รหัสใหม่ใช้ได้', withNew.status === 200, withNew.status);
    const refreshed = await post('/auth/refresh', { refreshToken: oldRefresh });
    check('เซสชันที่ออกก่อนรีเซ็ตถูกเพิกถอน', refreshed.status === 401, refreshed.status);
    const open = await prisma.passwordResetToken.count({ where: { userId, usedAt: null } });
    check('token ทุกใบของบัญชีถูกปิดหมด', open === 0, open);

    console.log('\n7) token ที่ใช้แล้ว / หมดอายุ');
    const reused = await post('/auth/reset-password', { token: good, newPassword: NEW_PASSWORD });
    check('ใช้ซ้ำ → 400', reused.status === 400, reused);
    const expired = await insertToken(userId, new Date(Date.now() - 1_000));
    const late = await post('/auth/reset-password', { token: expired, newPassword: NEW_PASSWORD });
    check('หมดอายุ → 400', late.status === 400, late);
    check(
      'ไม่มี / ใช้แล้ว / หมดอายุ ได้ข้อความเดียวกัน',
      bogus.body.error?.message === reused.body.error?.message &&
        reused.body.error?.message === late.body.error?.message,
      [bogus.body.error?.message, reused.body.error?.message, late.body.error?.message],
    );

    console.log('\n8) กดลิงก์เดียวกันสองแท็บพร้อมกัน');
    const race = await insertToken(userId);
    const both = await Promise.all([
      post('/auth/reset-password', { token: race, newPassword: NEW_PASSWORD }),
      post('/auth/reset-password', { token: race, newPassword: NEW_PASSWORD }),
    ]);
    const statuses = both.map((r) => r.status).sort();
    check('ผ่านได้ครั้งเดียว (200 + 400)', statuses[0] === 200 && statuses[1] === 400, statuses);

    console.log('\n9) บัญชีที่ถูกลบหลังออก token');
    const orphan = await insertToken(userId);
    await prisma.user.update({ where: { userId }, data: { deletedAt: new Date() } });
    const ghost = await post('/auth/reset-password', { token: orphan, newPassword: NEW_PASSWORD });
    check('→ 400', ghost.status === 400, ghost);
  } finally {
    // token / refresh token ของบัญชีนี้หายตามด้วย ON DELETE CASCADE
    await prisma.user.delete({ where: { userId } });
    await prisma.$disconnect();
  }

  process.exit(summary('(เฟส 2 — รีเซ็ตรหัสผ่าน)'));
}

void main();
