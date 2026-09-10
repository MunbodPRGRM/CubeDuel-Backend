/**
 * สโมคเทสเฟส 8 ก้อนที่ 1 — `PATCH /users/me` (ชื่อเล่น + สกินสีคิวบ์)
 *
 * ยิงผ่าน REST เหมือนเบราว์เซอร์จริง ไม่เรียกฟังก์ชันฝั่ง server ตรง ๆ
 * ต้องรัน `npm run dev` กับ `npm run seed` ไว้ก่อน
 *
 *   npm run smoke:profile
 */
import { API, check, login, summary } from './smoke-helpers.ts';

interface SelfUser {
  userId: number;
  username: string;
  nickname: string | null;
  cubeSkin: string;
  email: string;
}

async function patchProfile(
  token: string,
  body: unknown,
): Promise<{ status: number; data?: SelfUser; code?: string; message?: string }> {
  const res = await fetch(`${API}/users/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: SelfUser; error?: { code: string; message: string } };
  return {
    status: res.status,
    data: json.data,
    code: json.error?.code,
    message: json.error?.message,
  };
}

async function getJson<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const json = (await res.json()) as { data: T };
  return json.data;
}

async function main(): Promise<void> {
  const { token, userId } = await login('somchai');
  const before = await getJson<SelfUser>('/users/me', token);
  console.log(`\nบัญชีทดสอบ: ${before.username} (#${userId}) · สกินเดิม ${before.cubeSkin}\n`);

  console.log('1) แก้ชื่อเล่นกับสกินพร้อมกัน');
  const renamed = await patchProfile(token, { nickname: '  สมชาย  ', cubeSkin: 'neon' });
  check('ตอบ 200', renamed.status === 200, renamed);
  check('ชื่อเล่นถูก trim ก่อนบันทึก', renamed.data?.nickname === 'สมชาย', renamed.data?.nickname);
  check('สกินเปลี่ยนเป็น neon', renamed.data?.cubeSkin === 'neon', renamed.data?.cubeSkin);
  check('ยังคืน email ของเจ้าของบัญชี', typeof renamed.data?.email === 'string');

  console.log('\n2) โปรไฟล์สาธารณะเห็นชื่อใหม่ และยังไม่มี email');
  const publicProfile = await getJson<Record<string, unknown>>(`/users/${userId}`);
  check('ชื่อเล่นตรงกับที่เพิ่งแก้', publicProfile.nickname === 'สมชาย', publicProfile.nickname);
  check('ไม่มี email หลุดออกไป', !('email' in publicProfile));
  check('ไม่มี cubeSkin หลุดออกไป', !('cubeSkin' in publicProfile));

  console.log('\n3) ส่งมาช่องเดียวต้องไม่ล้างอีกช่อง');
  const skinOnly = await patchProfile(token, { cubeSkin: 'pastel' });
  check('สกินเปลี่ยน', skinOnly.data?.cubeSkin === 'pastel', skinOnly.data?.cubeSkin);
  check('ชื่อเล่นยังอยู่ครบ', skinOnly.data?.nickname === 'สมชาย', skinOnly.data?.nickname);

  console.log('\n4) ค่าที่ไม่ผ่านกติกา');
  const badSkin = await patchProfile(token, { cubeSkin: 'rainbow' });
  check(
    'สกินที่ไม่รู้จัก → 400',
    badSkin.status === 400 && badSkin.code === 'E_VALIDATION',
    badSkin,
  );
  const longName = await patchProfile(token, { nickname: 'ก'.repeat(51) });
  check('ชื่อเล่นเกิน 50 ตัว → 400', longName.status === 400, longName);
  const forbidden = await patchProfile(token, { username: 'hacker' });
  check('แก้ username ไม่ได้ → 400', forbidden.status === 400, forbidden);
  const emailChange = await patchProfile(token, { email: 'x@y.com' });
  check('แก้ email ไม่ได้ → 400', emailChange.status === 400, emailChange);
  const empty = await patchProfile(token, {});
  check('ไม่ส่งอะไรมาเลย → 400', empty.status === 400, empty);

  console.log('\n5) ไม่มี token ต้องแก้ไม่ได้');
  const anon = await fetch(`${API}/users/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cubeSkin: 'neon' }),
  });
  check('ไม่ล็อกอิน → 401', anon.status === 401, anon.status);

  console.log('\n6) ล้างชื่อเล่นด้วยช่องว่าง แล้วคืนค่าเดิม');
  const cleared = await patchProfile(token, { nickname: '   ' });
  check('ช่องว่างล้วน = null', cleared.data?.nickname === null, cleared.data?.nickname);
  const restored = await patchProfile(token, {
    nickname: before.nickname,
    cubeSkin: before.cubeSkin,
  });
  check(
    'คืนค่าเดิมได้ครบ',
    restored.data?.nickname === before.nickname && restored.data?.cubeSkin === before.cubeSkin,
    restored.data,
  );

  process.exit(summary('(เฟส 8 ก้อนที่ 1 — โปรไฟล์)'));
}

void main();
