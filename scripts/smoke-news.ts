/**
 * สโมคเทสเฟส 8 ก้อนที่ 2 — ข่าวสารและกิจกรรม (`/news` + `/admin/news`)
 * ปรับตามเฟส 13 ก้อนที่ 22: เลิกอัปโหลดรูป → ปกเป็นคีย์ `cover` (ADR-084)
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
import { API, check, login, summary } from './smoke-helpers.ts';

interface NewsDto {
  newsId: number;
  title: string;
  content?: string;
  excerpt?: string;
  cover: string;
  author: { userId: number; username: string };
}

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

  console.log('\n2) สร้างข่าวโดยไม่ส่งปก');
  const longBody = `บรรทัดแรกของข่าว\nบรรทัดที่สอง ${'ยาว'.repeat(80)}`;
  const created = await api(
    '/admin/news',
    jsonInit('POST', admin.token, { title: '  ทดสอบข่าวสโมค  ', content: longBody }),
  );
  const news = created.body.data as NewsDto;
  check('ตอบ 201', created.status === 201, created);
  check('หัวข้อถูก trim', news?.title === 'ทดสอบข่าวสโมค', news?.title);
  check('ผู้เขียนคือแอดมินที่ยิง', news?.author.userId === admin.userId, news?.author);
  check('ไม่ส่งปก = ได้ปก general', news?.cover === 'general', news?.cover);

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

  console.log('\n3) สร้างข่าวพร้อมปก');
  const withCover = await api(
    '/admin/news',
    jsonInit('POST', admin.token, { title: 'ข่าวมีปก', content: 'เนื้อหา', cover: 'maintenance' }),
  );
  const coverNews = withCover.body.data as NewsDto;
  check('ตอบ 201', withCover.status === 201, withCover);
  check('ได้ปกตามที่ส่ง', coverNews?.cover === 'maintenance', coverNews?.cover);
  const coverDetail = await api(`/news/${coverNews.newsId}`);
  check(
    'หน้ารายละเอียดคืน cover',
    (coverDetail.body.data as NewsDto)?.cover === 'maintenance',
    coverDetail.body.data,
  );
  check(
    'ไม่มีฟิลด์ image ใน response แล้ว',
    coverDetail.body.data !== undefined && !('image' in (coverDetail.body.data as object)),
  );

  for (const key of ['general', 'update', 'maintenance', 'penalty', 'event']) {
    const res = await api(
      `/admin/news/${coverNews.newsId}`,
      jsonInit('PATCH', admin.token, { cover: key }),
    );
    check(`ปก ${key} ใช้ได้`, res.status === 200 && (res.body.data as NewsDto)?.cover === key, res);
  }

  console.log('\n4) ค่าที่ต้องถูกปฏิเสธ');
  const badCover = await api(
    '/admin/news',
    jsonInit('POST', admin.token, { title: 'ปกผิด', content: 'x', cover: 'ban' }),
  );
  check('คีย์ปกนอกรายการ → 400', badCover.status === 400, badCover);
  const nullCover = await api(
    '/admin/news',
    jsonInit('POST', admin.token, { title: 'ปก null', content: 'x', cover: null }),
  );
  check('cover เป็น null → 400', nullCover.status === 400, nullCover);
  const legacy = await api(
    '/admin/news',
    jsonInit('POST', admin.token, { title: 'ฟิลด์รุ่นเก่า', content: 'x', image: '/uploads/x.png' }),
  );
  const legacyDto = legacy.body.data as NewsDto;
  check(
    'ส่ง image รุ่นเก่ามา = ถูกเมิน ได้ปก general',
    legacy.status === 201 && legacyDto?.cover === 'general',
    legacy,
  );
  if (legacyDto?.newsId) {
    await api(`/admin/news/${legacyDto.newsId}`, { method: 'DELETE', token: admin.token });
  }

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
    `/admin/news/${coverNews.newsId}`,
    jsonInit('PATCH', admin.token, { title: 'ข่าวมีปก (แก้แล้ว)' }),
  );
  const patchedDto = patched.body.data as NewsDto;
  check('หัวข้อเปลี่ยน', patchedDto?.title === 'ข่าวมีปก (แก้แล้ว)', patchedDto?.title);
  check(
    'ไม่ส่ง content มา = เนื้อข่าวไม่หาย',
    patchedDto?.content === 'เนื้อหา',
    patchedDto?.content,
  );
  check('ไม่ส่ง cover มา = ปกเดิมยังอยู่', patchedDto?.cover === 'event', patchedDto?.cover);

  const badPatch = await api(
    `/admin/news/${coverNews.newsId}`,
    jsonInit('PATCH', admin.token, { cover: 'poster' }),
  );
  check('PATCH ปกนอกรายการ → 400', badPatch.status === 400, badPatch);

  const emptyPatch = await api(
    `/admin/news/${coverNews.newsId}`,
    jsonInit('PATCH', admin.token, {}),
  );
  check('PATCH ที่ไม่มีอะไรให้แก้ → 400', emptyPatch.status === 400, emptyPatch);
  const missing = await api('/admin/news/999999', jsonInit('PATCH', admin.token, { title: 'x' }));
  check('แก้ข่าวที่ไม่มีอยู่ → 404', missing.status === 404, missing);

  console.log('\n6) ลบข่าว');
  const deleted = await api(`/admin/news/${coverNews.newsId}`, {
    method: 'DELETE',
    token: admin.token,
  });
  check('ลบสำเร็จ → 200', deleted.status === 200, deleted);
  const gone = await api(`/news/${coverNews.newsId}`);
  check('อ่านข่าวที่ลบแล้ว → 404', gone.status === 404, gone.status);

  console.log('\n7) AdminAuditLog ครบทุกการกระทำ (อ่าน DB ตรง ๆ — ไม่มี endpoint ให้อ่าน)');
  const prisma = new PrismaClient();
  const logs = await prisma.adminAuditLog.findMany({
    where: { adminId: admin.userId, action: { in: ['create_news', 'update_news', 'delete_news'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const forThisNews = logs.filter(
    (l) => (l.detail as { newsId?: number } | null)?.newsId === coverNews.newsId,
  );
  check(
    'มี log ตอนสร้าง',
    forThisNews.some((l) => l.action === 'create_news'),
  );
  check(
    'มี log ตอนแก้ (6 ครั้ง — ปก 5 + หัวข้อ 1)',
    forThisNews.filter((l) => l.action === 'update_news').length === 6,
    forThisNews.filter((l) => l.action === 'update_news').length,
  );
  check(
    'มี log ตอนลบ',
    forThisNews.some((l) => l.action === 'delete_news'),
  );
  const updateLog = forThisNews.find((l) => l.action === 'update_news');
  check(
    'log ตอนแก้เก็บค่าเก่าไว้ด้วย (มี cover)',
    (updateLog?.detail as { before?: { cover?: string } } | null)?.before?.cover !== undefined,
    updateLog?.detail,
  );

  // เก็บกวาดข่าวที่สร้างระหว่างเทส (ข่าวมีปกถูกลบไปแล้วในข้อ 6)
  await api(`/admin/news/${news.newsId}`, { method: 'DELETE', token: admin.token });
  await prisma.$disconnect();

  process.exit(summary('(เฟส 8 ก้อนที่ 2 — ข่าวสาร)'));
}

void main();
