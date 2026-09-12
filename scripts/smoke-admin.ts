/**
 * สโมคเทสเฟส 8 ก้อนที่ 3 — ระบบรายงานผู้เล่น + เครื่องมือแอดมิน
 *
 * ยิงผ่าน REST เหมือนเบราว์เซอร์จริง · ต้องรัน `npm run dev` กับ `npm run seed` ไว้ก่อน
 * และต้องตั้ง `DISABLE_RATE_LIMIT=true` ฝั่ง server ไม่งั้นโดน rate limit ของ `/reports` ตัดกลางทาง
 *
 *   npm run smoke:admin
 *
 * **ข้อยกเว้นเดียวกับ `smoke:news`:** เปิด Prisma อ่าน `AdminAuditLog` ตรง ๆ ตอนท้าย
 * เพราะไม่มี endpoint ไหนเปิดให้อ่าน log (ADR-050 ข้อ 6)
 */
import { PrismaClient } from '@prisma/client';
import { API, check, login, summary } from './smoke-helpers.ts';

const prisma = new PrismaClient();

interface Envelope {
  status: number;
  data?: unknown;
  error?: { code: string; message: string };
  meta?: { total: number };
}

async function api(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<Envelope> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json().catch(() => ({}))) as Omit<Envelope, 'status'>;
  return { status: res.status, ...json };
}

/** ล้างรายงานเก่าของคู่ผู้ใช้นี้ทิ้ง เพื่อให้กติกา "ซ้ำได้ 1 ครั้ง/24 ชม." เริ่มนับใหม่ทุกครั้งที่รันเทส */
async function clearReportsBetween(reporterId: number, reportedId: number): Promise<void> {
  await prisma.report.deleteMany({ where: { reporterId, reportedId } });
}

async function main(): Promise<void> {
  const admin = await login('admin');
  const reporter = await login('somchai');
  const target = await login('malee');
  await clearReportsBetween(reporter.userId, target.userId);
  // เทสนี้แก้คะแนนของ target จริง (แก้ทีละประเภท + reset ทั้งชุด) → จำค่าเดิมไว้คืนตอนจบ
  const originalRatings = await prisma.rating.findMany({ where: { userId: target.userId } });
  // ตั้ง bio ให้ผู้ถูกรายงานไว้ก่อน เพื่อทดสอบทั้ง "ถูกระงับแล้วซ่อน" (ข้อ 6) และ "แอดมินลบ" (ข้อ 6ก) — ADR-066
  await api('/users/me', {
    method: 'PATCH',
    token: target.token,
    body: { bio: 'ข้อความแนะนำตัวสำหรับสโมคเทส' },
  });
  console.log('');

  // ---------------------------------------------------------------- รายงาน (ฝั่งผู้ใช้)

  console.log('1) แจ้งรายงานผู้เล่น');
  const selfReport = await api('/reports', {
    method: 'POST',
    token: reporter.token,
    body: { reportedUserId: reporter.userId, reason: 'ทดสอบรายงานตัวเอง 1234567890' },
  });
  check('รายงานตัวเองไม่ได้ → 400', selfReport.status === 400, selfReport);

  const shortReason = await api('/reports', {
    method: 'POST',
    token: reporter.token,
    body: { reportedUserId: target.userId, reason: 'สั้น' },
  });
  check('เหตุผลสั้นกว่า 10 ตัว → 400', shortReason.status === 400, shortReason);

  const bothMatches = await api('/reports', {
    method: 'POST',
    token: reporter.token,
    body: {
      reportedUserId: target.userId,
      reason: 'แนบสองแมตช์พร้อมกันไม่ได้ 1234567890',
      matchId: 1,
      multiplayerMatchId: 1,
    },
  });
  check('แนบแมตช์สองช่องพร้อมกัน → 400', bothMatches.status === 400, bothMatches);

  const ghostUser = await api('/reports', {
    method: 'POST',
    token: reporter.token,
    body: { reportedUserId: 999999, reason: 'รายงานคนที่ไม่มีตัวตน 1234567890' },
  });
  check('รายงานผู้ใช้ที่ไม่มีอยู่ → 404', ghostUser.status === 404, ghostUser);

  // แมตช์ที่ผู้ถูกรายงานไม่ได้เล่นด้วย — ต้องถูกปฏิเสธ (ADR-050 ข้อ 1)
  const otherMatch = await prisma.match.findFirst({
    where: { player1Id: { not: target.userId }, player2Id: { not: target.userId } },
    select: { matchId: true },
  });
  if (otherMatch) {
    const wrongMatch = await api('/reports', {
      method: 'POST',
      token: reporter.token,
      body: {
        reportedUserId: target.userId,
        reason: 'แนบแมตช์ที่เขาไม่ได้เล่น 1234567890',
        matchId: otherMatch.matchId,
      },
    });
    check('แนบแมตช์ที่ผู้ถูกรายงานไม่ได้เล่น → 400', wrongMatch.status === 400, wrongMatch);
  }

  const ownMatch = await prisma.match.findFirst({
    where: { OR: [{ player1Id: target.userId }, { player2Id: target.userId }] },
    select: { matchId: true },
  });
  const created = await api('/reports', {
    method: 'POST',
    token: reporter.token,
    body: {
      reportedUserId: target.userId,
      reason: 'ใช้โปรแกรมช่วยแก้ เวลา 2.1 วินาทีในรูบิค 3x3x3',
      matchId: ownMatch?.matchId,
    },
  });
  const report = created.data as { reportId: number; reportStatus: string; matchId: number | null };
  check('แจ้งรายงานสำเร็จ → 201', created.status === 201, created);
  check('สถานะเริ่มต้นเป็น pending', report?.reportStatus === 'pending', report?.reportStatus);
  check(
    'แนบแมตช์ที่เขาเล่นจริงได้',
    report?.matchId === (ownMatch?.matchId ?? null),
    report?.matchId,
  );

  const duplicate = await api('/reports', {
    method: 'POST',
    token: reporter.token,
    body: { reportedUserId: target.userId, reason: 'รายงานซ้ำภายใน 24 ชั่วโมง 1234567890' },
  });
  check(
    'รายงานคนเดิมซ้ำใน 24 ชม. → 409',
    duplicate.status === 409 && duplicate.error?.code === 'E_CONFLICT',
    duplicate,
  );

  const anonReport = await api('/reports', {
    method: 'POST',
    body: { reportedUserId: target.userId, reason: 'ไม่ล็อกอินก็รายงานได้เหรอ 1234567890' },
  });
  check('ไม่ล็อกอิน → 401', anonReport.status === 401, anonReport.status);

  // ---------------------------------------------------------------- สิทธิ์ของ /admin

  console.log('\n2) สมาชิกธรรมดาแตะ /admin ไม่ได้เลย');
  for (const path of [
    '/admin/dashboard',
    '/admin/users',
    '/admin/reports',
    '/admin/matches/flagged',
  ]) {
    const res = await api(path, { token: reporter.token });
    check(`GET ${path} → 403`, res.status === 403, res.status);
  }

  // ---------------------------------------------------------------- แดชบอร์ด

  console.log('\n3) แดชบอร์ด');
  const dash = await api('/admin/dashboard', { token: admin.token });
  const d = dash.data as {
    activeRooms: number;
    onlineUsers: number;
    totalUsers: number;
    matchesToday: number;
    matchesLast7Days: number[];
    pendingReports: number;
    flaggedMatches: number;
    byCubeType: Record<string, number>;
  };
  check('ตอบ 200', dash.status === 200, dash);
  check('มีครบ 7 ช่องในกราฟ 7 วัน', d?.matchesLast7Days?.length === 7, d?.matchesLast7Days);
  check('ช่องสุดท้ายของกราฟ = matchesToday', d?.matchesLast7Days?.[6] === d?.matchesToday, {
    last: d?.matchesLast7Days?.[6],
    today: d?.matchesToday,
  });
  check(
    'ผลรวม byCubeType = matchesToday',
    Object.values(d?.byCubeType ?? {}).reduce((a, b) => a + b, 0) === d?.matchesToday,
    d?.byCubeType,
  );
  const dbUsers = await prisma.user.count({ where: { deletedAt: null } });
  check('totalUsers ตรงกับ DB', d?.totalUsers === dbUsers, { api: d?.totalUsers, db: dbUsers });
  check(
    'มีรายงานค้างอย่างน้อย 1 ใบ (ที่เพิ่งแจ้ง)',
    (d?.pendingReports ?? 0) >= 1,
    d?.pendingReports,
  );
  check(
    'activeRooms/onlineUsers เป็นตัวเลข',
    typeof d?.activeRooms === 'number' && typeof d?.onlineUsers === 'number',
  );

  // ---------------------------------------------------------------- ค้นหาผู้ใช้

  console.log('\n4) ค้นหา/ดูรายชื่อผู้ใช้');
  const search = await api(`/admin/users?q=malee`, { token: admin.token });
  const users = search.data as Array<{ userId: number; email: string; reportCount: number }>;
  check(
    'ค้นหาด้วยชื่อผู้ใช้เจอ',
    users?.some((u) => u.userId === target.userId),
    users?.length,
  );
  check('endpoint แอดมินส่ง email ออกได้', typeof users?.[0]?.email === 'string');
  check(
    'reportCount ของผู้ถูกรายงานมากกว่า 0',
    (users?.find((u) => u.userId === target.userId)?.reportCount ?? 0) > 0,
  );
  const upperSearch = await api(`/admin/users?q=MALEE`, { token: admin.token });
  check(
    'ค้นหาไม่สนตัวพิมพ์ใหญ่เล็ก',
    (upperSearch.data as unknown[])?.length === users?.length,
    (upperSearch.data as unknown[])?.length,
  );

  // ---------------------------------------------------------------- แก้คะแนน

  console.log('\n5) แก้คะแนน Elo');
  const beforeRating = await prisma.rating.findUnique({
    where: { userId_cubeType: { userId: target.userId, cubeType: 'CUBE_3X3X3' } },
  });
  const badRating = await api(`/admin/users/${target.userId}/rating`, {
    method: 'PATCH',
    token: admin.token,
    body: { cubeType: '3x3x3', eloRating: 9999 },
  });
  check('คะแนนเกิน 4000 → 400', badRating.status === 400, badRating);

  const edited = await api(`/admin/users/${target.userId}/rating`, {
    method: 'PATCH',
    token: admin.token,
    body: { cubeType: '3x3x3', eloRating: 1234, note: 'สโมคเทส' },
  });
  check('แก้คะแนนสำเร็จ', edited.status === 200, edited);
  const afterRating = await prisma.rating.findUnique({
    where: { userId_cubeType: { userId: target.userId, cubeType: 'CUBE_3X3X3' } },
  });
  check('คะแนนใน DB เปลี่ยนจริง', afterRating?.eloRating === 1234, afterRating?.eloRating);
  check(
    'ไม่แตะ wins/losses/best_time',
    afterRating?.wins === beforeRating?.wins &&
      afterRating?.losses === beforeRating?.losses &&
      String(afterRating?.bestTime) === String(beforeRating?.bestTime),
  );
  const otherType = await prisma.rating.findUnique({
    where: { userId_cubeType: { userId: target.userId, cubeType: 'CUBE_2X2X2' } },
  });
  check('ประเภทอื่นไม่ถูกแตะ', otherType?.eloRating !== 1234, otherType?.eloRating);

  // ---------------------------------------------------------------- ระงับ/ปลดระงับ

  console.log('\n6) ระงับและปลดระงับบัญชี');
  const selfSuspend = await api(`/admin/users/${admin.userId}/status`, {
    method: 'PATCH',
    token: admin.token,
    body: { status: 'suspended' },
  });
  check('ระงับบัญชีตัวเอง → 400', selfSuspend.status === 400, selfSuspend);

  const suspended = await api(`/admin/users/${target.userId}/status`, {
    method: 'PATCH',
    token: admin.token,
    body: { status: 'suspended', note: 'สโมคเทส' },
  });
  check('ระงับสำเร็จ', (suspended.data as { status?: string })?.status === 'suspended', suspended);

  const hiddenBio = await api(`/users/${target.userId}`);
  check(
    'บัญชีที่ถูกระงับ โปรไฟล์สาธารณะคืน bio = null',
    (hiddenBio.data as { bio?: string | null })?.bio === null,
    hiddenBio.data,
  );
  const bioInDb = await prisma.user.findUnique({ where: { userId: target.userId } });
  check('แต่ข้อความจริงยังอยู่ใน DB (ปลดระงับแล้วได้คืน)', bioInDb?.bio !== null, bioInDb?.bio);

  const blockedLogin = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'malee', password: 'Password123!' }),
  });
  check('บัญชีที่ถูกระงับล็อกอินไม่ได้ → 403', blockedLogin.status === 403, blockedLogin.status);
  const liveTokens = await prisma.refreshToken.count({
    where: { userId: target.userId, revokedAt: null },
  });
  check('refresh token ถูกเพิกถอนหมด', liveTokens === 0, liveTokens);

  const unsuspended = await api(`/admin/users/${target.userId}/status`, {
    method: 'PATCH',
    token: admin.token,
    body: { status: 'active' },
  });
  const unsuspendedDto = unsuspended.data as { status?: string; suspendedUntil?: string | null };
  check('ปลดระงับสำเร็จ', unsuspendedDto?.status === 'active', unsuspended);
  check('ปลดระงับแล้วล้าง suspendedUntil', unsuspendedDto?.suspendedUntil === null);
  const backBio = await api(`/users/${target.userId}`);
  check(
    'ปลดระงับแล้ว bio กลับมาแสดงเอง',
    (backBio.data as { bio?: string | null })?.bio === 'ข้อความแนะนำตัวสำหรับสโมคเทส',
    backBio.data,
  );

  // ---------------------------------------------------------------- ลบ bio (ADR-066)

  console.log('\n6ก) ลบข้อความแนะนำตัวที่ไม่เหมาะสม');
  const inList = await api(`/admin/users?q=malee`, { token: admin.token });
  check(
    'รายชื่อของแอดมินส่ง bio มาด้วย',
    (inList.data as Array<{ userId: number; bio: string | null }>)?.find(
      (u) => u.userId === target.userId,
    )?.bio === 'ข้อความแนะนำตัวสำหรับสโมคเทส',
    inList.data,
  );

  // นับ log ไว้ก่อน แล้วเทียบตอนท้าย — รันเทสซ้ำหลายรอบก็ยังเช็คได้ว่า "ลบซ้ำไม่เขียน log เปล่า"
  const clearBioLogsBefore = await prisma.adminAuditLog.count({
    where: { action: 'clear_bio', targetUserId: target.userId },
  });

  const memberClear = await api(`/admin/users/${target.userId}/bio`, {
    method: 'DELETE',
    token: reporter.token,
  });
  check('สมาชิกธรรมดาลบ bio คนอื่นไม่ได้ → 403', memberClear.status === 403, memberClear);

  const cleared = await api(`/admin/users/${target.userId}/bio`, {
    method: 'DELETE',
    token: admin.token,
  });
  check(
    'แอดมินลบสำเร็จ',
    cleared.status === 200 && (cleared.data as { cleared?: boolean })?.cleared === true,
    cleared,
  );
  const afterClear = await prisma.user.findUnique({ where: { userId: target.userId } });
  check('bio ใน DB เป็น null แล้ว', afterClear?.bio === null, afterClear?.bio);

  const again = await api(`/admin/users/${target.userId}/bio`, {
    method: 'DELETE',
    token: admin.token,
  });
  check(
    'ลบซ้ำตอนไม่มี bio → 200 แต่ cleared = false',
    again.status === 200 && (again.data as { cleared?: boolean })?.cleared === false,
    again,
  );

  // ---------------------------------------------------------------- ตัดสินรายงาน

  console.log('\n7) ตัดสินรายงาน');
  const pending = await api('/admin/reports?status=pending', { token: admin.token });
  const pendingRows = pending.data as Array<{
    reportId: number;
    reported: { reportCount: number };
  }>;
  check(
    'รายงานที่เพิ่งแจ้งอยู่ในรายการ pending',
    pendingRows?.some((r) => r.reportId === report.reportId),
    pendingRows?.length,
  );
  check(
    'รายการบอกจำนวนครั้งที่ผู้ถูกรายงานเคยถูกแจ้ง',
    (pendingRows?.find((r) => r.reportId === report.reportId)?.reported.reportCount ?? 0) >= 1,
  );

  const resolved = await api(`/admin/reports/${report.reportId}`, {
    method: 'PATCH',
    token: admin.token,
    body: { action: 'reset_rating', adminNote: 'สโมคเทส — รีเซ็ตคะแนน' },
  });
  const resolvedDto = resolved.data as { reportStatus?: string; actionTaken?: string };
  check('ตัดสินสำเร็จ', resolved.status === 200, resolved);
  check('สถานะกลายเป็น resolved', resolvedDto?.reportStatus === 'resolved', resolvedDto);
  check('บันทึกผลการตัดสินไว้', resolvedDto?.actionTaken === 'reset_rating', resolvedDto);

  const ratingsAfterReset = await prisma.rating.findMany({ where: { userId: target.userId } });
  check(
    'reset_rating คืนคะแนนเป็น 1000 ครบทั้ง 4 ประเภท',
    ratingsAfterReset.length === 4 && ratingsAfterReset.every((r) => r.eloRating === 1000),
    ratingsAfterReset.map((r) => r.eloRating),
  );

  const resolveTwice = await api(`/admin/reports/${report.reportId}`, {
    method: 'PATCH',
    token: admin.token,
    body: { action: 'none' },
  });
  check('ตัดสินซ้ำ → 409', resolveTwice.status === 409, resolveTwice);

  const badAction = await api(`/admin/reports/${report.reportId}`, {
    method: 'PATCH',
    token: admin.token,
    body: { action: 'ban_forever' },
  });
  check('ผลการตัดสินนอกรายการ → 400', badAction.status === 400, badAction);

  // ---------------------------------------------------------------- แมตช์ที่ถูก flag

  console.log('\n8) แมตช์ที่ถูก flag');
  const flagList = await api('/admin/matches/flagged?verdict=all', { token: admin.token });
  const flags = flagList.data as Array<{
    flagId: number;
    userId?: number;
    user: { userId: number };
    hasMoveLog: boolean;
    moveLog?: unknown;
  }>;
  check('อ่านรายการ flag ได้', flagList.status === 200, flagList.status);
  check(
    'รายการไม่ส่ง moveLog ออกมา',
    flags?.every((f) => f.moveLog === undefined),
    flags?.[0],
  );

  if (flags?.length) {
    const flagId = flags[0]!.flagId;
    const one = await api(`/admin/matches/flagged/${flagId}`, { token: admin.token });
    check(
      'เปิดทีละใบได้ moveLog มาด้วย',
      'moveLog' in (one.data as object),
      Object.keys(one.data as object),
    );

    const reviewed = await api(`/admin/matches/flagged/${flagId}`, {
      method: 'PATCH',
      token: admin.token,
      body: { verdict: 'inconclusive', note: 'สโมคเทส' },
    });
    const reviewedDto = reviewed.data as { verdict?: string; reviewedBy?: number };
    check('ตัดสิน flag ได้', reviewedDto?.verdict === 'inconclusive', reviewed);
    check('บันทึกว่าใครเป็นคนตรวจ', reviewedDto?.reviewedBy === admin.userId, reviewedDto);

    // ตัดสิน flag **ไม่** ไประงับบัญชีให้เอง — ถ้าจะระงับต้องสั่งที่ /admin/users/:id/status แยก (ADR-050 ข้อ 5)
    const flaggedUser = await prisma.user.findUnique({ where: { userId: flags[0]!.user.userId } });
    check(
      'ตัดสิน flag แล้วบัญชีผู้เล่นไม่ถูกแตะ',
      flaggedUser?.status === 'ACTIVE',
      flaggedUser?.status,
    );
  } else {
    console.log('  (ข้าม — ยังไม่มี flag ในฐานข้อมูล)');
  }

  const badVerdict = await api('/admin/matches/flagged/999999', {
    method: 'PATCH',
    token: admin.token,
    body: { verdict: 'clean' },
  });
  check('ตัดสิน flag ที่ไม่มีอยู่ → 404', badVerdict.status === 404, badVerdict.status);

  // ---------------------------------------------------------------- AdminAuditLog

  console.log('\n9) AdminAuditLog ครบทุกการกระทำ (อ่าน DB ตรง ๆ — ไม่มี endpoint ให้อ่าน)');
  const logs = await prisma.adminAuditLog.findMany({
    where: { adminId: admin.userId, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    orderBy: { createdAt: 'desc' },
  });
  const actions = new Set(logs.map((l) => l.action));
  for (const action of [
    'edit_rating',
    'suspend_user',
    'unsuspend_user',
    'clear_bio',
    'resolve_report',
  ]) {
    check(`มี log ${action}`, actions.has(action), [...actions]);
  }
  if (flags?.length) check('มี log review_flag', actions.has('review_flag'), [...actions]);

  const editLog = logs.find(
    (l) =>
      l.action === 'edit_rating' && (l.detail as { before?: number } | null)?.before !== undefined,
  );
  check('log แก้คะแนนเก็บค่าเก่า/ค่าใหม่', editLog !== undefined, editLog?.detail);
  const bioLog = logs.find((l) => l.action === 'clear_bio');
  check(
    'log ลบ bio เก็บข้อความเดิมไว้เป็นหลักฐาน',
    (bioLog?.detail as { before?: string } | null)?.before === 'ข้อความแนะนำตัวสำหรับสโมคเทส',
    bioLog?.detail,
  );
  const clearBioLogsNow = await prisma.adminAuditLog.count({
    where: { action: 'clear_bio', targetUserId: target.userId },
  });
  check(
    'ลบสำเร็จเขียน log ครั้งเดียว — ลบซ้ำตอนไม่มี bio ไม่เขียน log เปล่า',
    clearBioLogsNow === clearBioLogsBefore + 1,
    { before: clearBioLogsBefore, now: clearBioLogsNow },
  );
  check(
    'log ผูกกับผู้ใช้ที่ถูกกระทำ',
    logs.filter((l) => l.action === 'suspend_user').every((l) => l.targetUserId !== null),
  );

  // เก็บกวาด: คืนคะแนนกับรายงานให้เหมือนก่อนเริ่มเทส
  await clearReportsBetween(reporter.userId, target.userId);
  for (const rating of originalRatings) {
    await prisma.rating.update({
      where: { userId_cubeType: { userId: rating.userId, cubeType: rating.cubeType } },
      data: { eloRating: rating.eloRating },
    });
  }
  await prisma.$disconnect();

  process.exit(summary('(เฟส 8 ก้อนที่ 3 — รายงาน + แอดมิน)'));
}

void main();
