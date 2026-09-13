/**
 * สโมคเทสรีเซ็ตรหัสผ่านด้วย username + อีเมล (ADR-069)
 *
 * ต้องรัน `npm run dev` ไว้ก่อน · ควรเปิด server ด้วย `DISABLE_RATE_LIMIT=true` เพราะสคริปต์ยิงหลายรอบ
 * บัญชีทดสอบ (member 1 + admin 1) สร้างใหม่ทุกรอบแล้วลบทิ้งตอนจบ
 *
 *   npm run smoke:reset
 */
import { PrismaClient, UserRole } from '@prisma/client';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { API, check, summary } from './smoke-helpers.js';

const prisma = new PrismaClient();

const OLD_PASSWORD = 'OldPass123';
const NEW_PASSWORD = 'NewPass456';

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

async function main(): Promise<void> {
  const stamp = Date.now();
  const passwordHash = await hashPassword(OLD_PASSWORD);
  const member = await prisma.user.create({
    data: { username: `reset_probe_${stamp}`, email: `reset_probe_${stamp}@smoke.local`, passwordHash },
  });
  const admin = await prisma.user.create({
    data: {
      username: `reset_admin_${stamp}`,
      email: `reset_admin_${stamp}@smoke.local`,
      passwordHash,
      role: UserRole.ADMIN,
    },
  });
  const { userId, username, email } = member;
  console.log(`\nบัญชีทดสอบ: ${username} (#${userId}) · แอดมิน #${admin.userId}\n`);

  try {
    console.log('1) forgot-password ถูกตัดแล้ว (ADR-068)');
    const gone = await post('/auth/forgot-password', { email });
    check('→ 404', gone.status === 404, gone);

    console.log('\n2) ข้อมูลไม่ครบ / รหัสใหม่ไม่ผ่านกติกา');
    const empty = await post('/auth/reset-password', {});
    check('body ว่าง → 400', empty.status === 400, empty);
    const weak = await post('/auth/reset-password', { username, email, newPassword: 'short' });
    check('→ 400 พร้อม fields.newPassword', weak.status === 400 && typeof weak.body.error?.fields?.newPassword === 'string', weak);

    console.log('\n3) ไม่ตรง — ข้อความเดียวกันทุกกรณี');
    const wrongEmail = await post('/auth/reset-password', { username, email: `x_${email}`, newPassword: NEW_PASSWORD });
    check('อีเมลผิด → 400', wrongEmail.status === 400, wrongEmail);
    const noUser = await post('/auth/reset-password', { username: `nobody_${stamp}`, email, newPassword: NEW_PASSWORD });
    check('ไม่มีบัญชี → 400', noUser.status === 400, noUser);
    const asAdmin = await post('/auth/reset-password', {
      username: admin.username,
      email: admin.email,
      newPassword: NEW_PASSWORD,
    });
    check('บัญชีแอดมิน (ข้อมูลถูก) → 400', asAdmin.status === 400, asAdmin);
    check(
      'สามกรณีได้ข้อความเดียวกัน',
      wrongEmail.body.error?.message === noUser.body.error?.message &&
        noUser.body.error?.message === asAdmin.body.error?.message,
      [wrongEmail.body.error?.message, noUser.body.error?.message, asAdmin.body.error?.message],
    );
    const adminRow = await prisma.user.findUniqueOrThrow({ where: { userId: admin.userId } });
    check('รหัสผ่านแอดมินไม่เปลี่ยน', await verifyPassword(OLD_PASSWORD, adminRow.passwordHash ?? ''));

    console.log('\n4) รีเซ็ตสำเร็จ');
    const before = await post('/auth/login', { identifier: username, password: OLD_PASSWORD });
    check('ล็อกอินด้วยรหัสเดิมได้ก่อนรีเซ็ต', before.status === 200, before.status);
    const oldRefresh: string | undefined = before.body.data?.refreshToken;

    // อีเมลพิมพ์ใหญ่ + เว้นวรรค ต้องยังตรง (schema แปลงให้)
    const reset = await post('/auth/reset-password', {
      username,
      email: `  ${email.toUpperCase()} `,
      newPassword: NEW_PASSWORD,
    });
    check('→ 200 passwordReset', reset.status === 200 && reset.body.data?.passwordReset === true, reset);
    const withOld = await post('/auth/login', { identifier: username, password: OLD_PASSWORD });
    check('รหัสเดิมใช้ไม่ได้แล้ว', withOld.status === 401, withOld.status);
    const withNew = await post('/auth/login', { identifier: username, password: NEW_PASSWORD });
    check('รหัสใหม่ใช้ได้', withNew.status === 200, withNew.status);
    const refreshed = await post('/auth/refresh', { refreshToken: oldRefresh });
    check('เซสชันที่ออกก่อนรีเซ็ตถูกเพิกถอน', refreshed.status === 401, refreshed.status);

    console.log('\n5) บัญชีที่ถูกลบ');
    await prisma.user.update({ where: { userId }, data: { deletedAt: new Date() } });
    const ghost = await post('/auth/reset-password', { username, email, newPassword: NEW_PASSWORD });
    check('→ 400', ghost.status === 400, ghost);
  } finally {
    await prisma.user.deleteMany({ where: { userId: { in: [userId, admin.userId] } } });
    await prisma.$disconnect();
  }

  process.exit(summary('(เฟส 2 — รีเซ็ตรหัสผ่านด้วย username + อีเมล)'));
}

void main();
