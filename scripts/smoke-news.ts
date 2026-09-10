/**
 * สโมคเทสเฟส 8 ก้อนที่ 2 — ข่าวสารและกิจกรรม (`/news` + `/admin/news`)
 *
 * ยิงผ่าน REST เหมือนเบราว์เซอร์จริง · ต้องรัน `npm run dev` กับ `npm run seed` ไว้ก่อน
 *
 *   npm run smoke:news
 *
 * **ข้อยกเว้นข้อเดียว:** ตอนท้ายเปิด Prisma อ่าน `AdminAuditLog` ตรง ๆ เพราะ
 * ไม่มี endpoint ไหนใน `api-contract.md` ที่เปิดให้อ่าน log — แต่กฎ ADR-017 บังคับว่าต้องมีแถว
 * ถ้าไม่ตรวจตรงนี้ ก็ไม่มีอะไรจับได้เลยว่าลืมเขียน log
 */
import { PrismaClient } from '@prisma/client';
import { API, SERVER_URL, check, login, summary } from './smoke-helpers.ts';

interface NewsDto {
  newsId: number;
  title: string;
  content?: string;
  excerpt?: string;
  image: string | null;
  author: { userId: number; username: string };
}

/** PNG 1x1 จริง (base64) — ใช้ทดสอบทางที่ผ่าน */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function api(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{
  status: number;
  body: { data?: unknown; error?: { code: string; message: string } };
}> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${API}${path}`, { ...rest, headers });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown };
  return { status: res.status, body };
}

function jsonInit(
  method: string,
  token: string,
  payload: unknown,
): RequestInit & { token: string } {
  return {
    method,
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function formInit(
  method: string,
  token: string,
  fields: Record<string, string>,
  file?: { name: string; type: string; bytes: Buffer },
): RequestInit & { token: string } {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file)
    form.append('image', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  return { method, token, body: form };
}

async function main(): Promise<void> {
  const admin = await login('admin');
  const member = await login('somchai');
  console.log('');

  console.log('1) สิทธิ์การเข้าถึง');
  const anonList = await fetch(`${API}/news?limit=5`);
  check('อ่านข่าวได้โดยไม่ต้องล็อกอิน', anonList.status === 200, anonList.status);
  const memberCreate = await api(
    '/admin/news',
    jsonInit('POST', member.token, { title: 'x', content: 'y' }),
  );
  check(
    'สมาชิกธรรมดาสร้างข่าวไม่ได้ → 403',
    memberCreate.status === 403 && memberCreate.body.error?.code === 'E_FORBIDDEN',
    memberCreate,
  );
  const anonCreate = await fetch(`${API}/admin/news`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x', content: 'y' }),
  });
  check('ไม่ล็อกอินสร้างข่าวไม่ได้ → 401', anonCreate.status === 401, anonCreate.status);

  console.log('\n2) สร้างข่าวแบบไม่มีรูป (JSON)');
  const longBody = `บรรทัดแรกของข่าว\nบรรทัดที่สอง ${'ยาว'.repeat(80)}`;
  const created = await api(
    '/admin/news',
    jsonInit('POST', admin.token, { title: '  ทดสอบข่าวสโมค  ', content: longBody }),
  );
  const news = created.body.data as NewsDto;
  check('ตอบ 201', created.status === 201, created);
  check('หัวข้อถูก trim', news?.title === 'ทดสอบข่าวสโมค', news?.title);
  check('ผู้เขียนคือแอดมินที่ยิง', news?.author.userId === admin.userId, news?.author);
  check('ข่าวใหม่ยังไม่มีรูป', news?.image === null, news?.image);

  const detail = await api(`/news/${news.newsId}`);
  const detailDto = detail.body.data as NewsDto;
  check('รายละเอียดคืน content เต็ม', detailDto?.content === longBody);
  check('รายละเอียดไม่มี excerpt', detailDto !== undefined && !('excerpt' in detailDto));

  const list = await api('/news?limit=5');
  const rows = list.body.data as NewsDto[];
  const inList = rows.find((r) => r.newsId === news.newsId);
  check('ข่าวใหม่อยู่บนสุดของรายการ', rows[0]?.newsId === news.newsId, rows[0]?.newsId);
  check(
    'รายการคืน excerpt ไม่ใช่ content',
    inList?.excerpt !== undefined && inList.content === undefined,
  );
  check(
    'excerpt ยาวไม่เกิน 161 ตัว และไม่มีขึ้นบรรทัดใหม่',
    (inList?.excerpt?.length ?? 0) <= 161 && !inList?.excerpt?.includes('\n'),
    inList?.excerpt?.length,
  );

  console.log('\n3) สร้างข่าวพร้อมรูป (multipart) แล้วเปิดรูปจริง');
  const withImage = await api(
    '/admin/news',
    formInit(
      'POST',
      admin.token,
      { title: 'ข่าวมีรูป', content: 'เนื้อหา' },
      {
        name: 'cover.png',
        type: 'image/png',
        bytes: PNG_1X1,
      },
    ),
  );
  const imageNews = withImage.body.data as NewsDto;
  check('ตอบ 201', withImage.status === 201, withImage);
  check(
    'พาธรูปขึ้นต้นด้วย /uploads/news/',
    imageNews?.image?.startsWith('/uploads/news/') === true,
    imageNews?.image,
  );
  check(
    'นามสกุลเป็น .png ตามชนิดจริง',
    imageNews?.image?.endsWith('.png') === true,
    imageNews?.image,
  );

  const imageRes = await fetch(`${SERVER_URL}${imageNews.image}`);
  check('เปิดรูปผ่าน HTTP ได้ 200', imageRes.status === 200, imageRes.status);
  check(
    'content-type เป็น image/png',
    imageRes.headers.get('content-type')?.includes('image/png') === true,
    imageRes.headers.get('content-type'),
  );

  console.log('\n4) ไฟล์ที่ต้องถูกปฏิเสธ');
  const fakePng = await api(
    '/admin/news',
    formInit(
      'POST',
      admin.token,
      { title: 'ไฟล์ปลอม', content: 'x' },
      {
        name: 'evil.png',
        type: 'image/png',
        bytes: Buffer.from('<?php echo "not a png"; ?>'),
      },
    ),
  );
  check('ไฟล์ที่หัวไม่ใช่รูป → 400', fakePng.status === 400, fakePng);

  const tooBig = await api(
    '/admin/news',
    formInit(
      'POST',
      admin.token,
      { title: 'ไฟล์ใหญ่', content: 'x' },
      {
        name: 'big.png',
        type: 'image/png',
        bytes: Buffer.concat([PNG_1X1, Buffer.alloc(2 * 1024 * 1024)]),
      },
    ),
  );
  check('ไฟล์เกิน 2 MB → 400', tooBig.status === 400, tooBig);

  const wrongType = await api(
    '/admin/news',
    formInit(
      'POST',
      admin.token,
      { title: 'ไฟล์ผิดชนิด', content: 'x' },
      {
        name: 'doc.pdf',
        type: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4'),
      },
    ),
  );
  check('ชนิดไฟล์นอกรายการ → 400', wrongType.status === 400, wrongType);

  const noTitle = await api(
    '/admin/news',
    jsonInit('POST', admin.token, { content: 'ไม่มีหัวข้อ' }),
  );
  check('ไม่มีหัวข้อ → 400', noTitle.status === 400, noTitle);
  const longTitle = await api(
    '/admin/news',
    jsonInit('POST', admin.token, { title: 'ก'.repeat(151), content: 'x' }),
  );
  check('หัวข้อเกิน 150 ตัว → 400', longTitle.status === 400, longTitle);

  console.log('\n5) แก้ไขข่าว');
  const patched = await api(
    `/admin/news/${imageNews.newsId}`,
    jsonInit('PATCH', admin.token, { title: 'ข่าวมีรูป (แก้แล้ว)' }),
  );
  const patchedDto = patched.body.data as NewsDto;
  check('หัวข้อเปลี่ยน', patchedDto?.title === 'ข่าวมีรูป (แก้แล้ว)', patchedDto?.title);
  check(
    'ไม่ส่ง content มา = เนื้อข่าวไม่หาย',
    patchedDto?.content === 'เนื้อหา',
    patchedDto?.content,
  );
  check('ไม่ส่งรูปมา = รูปเดิมยังอยู่', patchedDto?.image === imageNews.image, patchedDto?.image);

  const conflict = await api(
    `/admin/news/${imageNews.newsId}`,
    formInit(
      'PATCH',
      admin.token,
      { removeImage: 'true' },
      {
        name: 'new.png',
        type: 'image/png',
        bytes: PNG_1X1,
      },
    ),
  );
  check('ส่งรูปใหม่พร้อมสั่งลบรูป → 400', conflict.status === 400, conflict);

  const replaced = await api(
    `/admin/news/${imageNews.newsId}`,
    formInit('PATCH', admin.token, {}, { name: 'new.png', type: 'image/png', bytes: PNG_1X1 }),
  );
  const replacedDto = replaced.body.data as NewsDto;
  check('ส่งมาแค่ไฟล์รูป (ไม่มีช่องข้อความ) ก็แก้ได้ → 200', replaced.status === 200, replaced);
  check(
    'เปลี่ยนรูปได้ (พาธเปลี่ยน)',
    typeof replacedDto?.image === 'string' && replacedDto.image !== imageNews.image,
    replacedDto?.image,
  );
  const oldImage = await fetch(`${SERVER_URL}${imageNews.image}`);
  check('ไฟล์รูปเก่าถูกลบทิ้ง → 404', oldImage.status === 404, oldImage.status);

  const removed = await api(
    `/admin/news/${imageNews.newsId}`,
    jsonInit('PATCH', admin.token, { removeImage: true }),
  );
  check(
    'สั่งลบรูปแล้ว image เป็น null',
    (removed.body.data as NewsDto)?.image === null,
    removed.body.data,
  );
  const removedFile = await fetch(`${SERVER_URL}${replacedDto.image}`);
  check('ไฟล์ที่ถูกถอดออกถูกลบทิ้ง → 404', removedFile.status === 404, removedFile.status);

  const emptyPatch = await api(
    `/admin/news/${imageNews.newsId}`,
    jsonInit('PATCH', admin.token, {}),
  );
  check('PATCH ที่ไม่มีอะไรให้แก้ → 400', emptyPatch.status === 400, emptyPatch);
  const missing = await api('/admin/news/999999', jsonInit('PATCH', admin.token, { title: 'x' }));
  check('แก้ข่าวที่ไม่มีอยู่ → 404', missing.status === 404, missing);

  console.log('\n6) ลบข่าว');
  const deleted = await api(`/admin/news/${imageNews.newsId}`, {
    method: 'DELETE',
    token: admin.token,
  });
  check('ลบสำเร็จ → 200', deleted.status === 200, deleted);
  const gone = await api(`/news/${imageNews.newsId}`);
  check('อ่านข่าวที่ลบแล้ว → 404', gone.status === 404, gone.status);

  console.log('\n7) AdminAuditLog ครบทุกการกระทำ (อ่าน DB ตรง ๆ — ไม่มี endpoint ให้อ่าน)');
  const prisma = new PrismaClient();
  const logs = await prisma.adminAuditLog.findMany({
    where: { adminId: admin.userId, action: { in: ['create_news', 'update_news', 'delete_news'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const forThisNews = logs.filter(
    (l) => (l.detail as { newsId?: number } | null)?.newsId === imageNews.newsId,
  );
  check(
    'มี log ตอนสร้าง',
    forThisNews.some((l) => l.action === 'create_news'),
  );
  check(
    'มี log ตอนแก้ (3 ครั้ง)',
    forThisNews.filter((l) => l.action === 'update_news').length === 3,
    forThisNews.filter((l) => l.action === 'update_news').length,
  );
  check(
    'มี log ตอนลบ',
    forThisNews.some((l) => l.action === 'delete_news'),
  );
  const updateLog = forThisNews.find((l) => l.action === 'update_news');
  check(
    'log ตอนแก้เก็บค่าเก่าไว้ด้วย',
    (updateLog?.detail as { before?: unknown } | null)?.before !== undefined,
    updateLog?.detail,
  );

  // เก็บกวาดข่าวที่สร้างระหว่างเทส (ข่าวมีรูปถูกลบไปแล้วในข้อ 6)
  await api(`/admin/news/${news.newsId}`, { method: 'DELETE', token: admin.token });
  await prisma.$disconnect();

  process.exit(summary('(เฟส 8 ก้อนที่ 2 — ข่าวสาร)'));
}

void main();
