/**
 * สโมคเทสสถิติ + ประวัติ + กระดานอันดับรายสัปดาห์ (เฟส 7 ก้อนที่ 2)
 *
 * ต้องมี server รันอยู่ (`npm run dev`) + DB ที่ seed แล้ว (`npm run seed`)
 * รันด้วย: npm run smoke:stats     (เร็ว — ไม่ได้เล่นแมตช์จริง)
 *
 * ต่างจากสโมคเทสตัวอื่นตรงที่ **เขียนผลแมตช์ลง DB ตรง ๆ** แทนที่จะเล่นผ่าน Socket.IO
 * เพราะสถิติต้องการประวัติหลายแมตช์ที่มีเวลาเป๊ะ ๆ ตามที่คำนวณด้วยมือไว้ — เล่นจริงคุมเวลาไม่ได้
 * ส่วน **การตรวจทั้งหมดยิงผ่าน REST เหมือนเบราว์เซอร์จริง** ไม่ได้เรียกฟังก์ชันฝั่ง server ตรง ๆ
 *
 * ครอบ: best/worst/mean/ao5/ao12/ao100 · dnfCount · สตรีค · ประวัติรวมสองระบบแมตช์ ·
 *       ตัวกรอง kind/roomType · แบ่งหน้า · กระดานรายสัปดาห์ (ผลรวม elo_change + ขอบสัปดาห์) ·
 *       cache 60 วินาทีของกระดานรายสัปดาห์
 *
 * ⚠️ ลบแมตช์ **pyramorphix** ของผู้ใช้ 4 คนที่ใช้ทดสอบทิ้งก่อนเริ่มทุกครั้ง แล้วคืนค่า `Rating`
 *    ให้เหมือนเดิมตอนจบ — ถ้าเคยรัน `scripts/perf-leaderboard.ts` ไว้ ควร `--clean` ก่อน
 *    ไม่งั้นกระดานรายสัปดาห์จะมีข้อมูลขยะปนจนอ่านผลยาก (แต่เทสยังผ่าน เพราะตรวจเฉพาะแถวของตัวเอง)
 */
import { CubeType, Prisma, PrismaClient, RoomMode, RoomType, SolveResult } from '@prisma/client';
import { API, check, summary } from './smoke-helpers.js';
import { weekRangeOf } from '../src/lib/week.js';

const prisma = new PrismaClient();

const CUBE_TYPE = 'pyramorphix';
const PRISMA_CUBE_TYPE = CubeType.PYRAMORPHIX;

/** ผู้ใช้จาก `npm run seed` — คนแรกคือเจ้าของสถิติที่ตรวจ ที่เหลือเป็นคู่แข่ง */
const FIXTURE_USERNAMES = ['somchai', 'malee', 'nattapong', 'pimchanok'] as const;

const HOUR = 60 * 60 * 1000;
const dec = (n: number) => new Prisma.Decimal(n.toFixed(2));

// ---------------------------------------------------------------- ค่าที่คำนวณด้วยมือไว้แล้ว
//
// solve ของ somchai เรียงจากใหม่ไปเก่า:
//   [ 8.00 ชนะ ] [ 11.00 ชนะ (หลายคน) ] [ DNF แพ้ ]  ← สัปดาห์นี้
//   [ 9.00 ชนะ (ห้องสร้างเอง) ] [ 12.00 ชนะ ] [ 15.00 ชนะ ] [ 20.00 แพ้ ]  ← สัปดาห์ที่แล้ว
//
//   best   = 8.00                      worst = 20.00
//   mean   = (8+11+9+12+15+20)/6 = 75/6 = 12.50
//   ao5    = 5 ครั้งล่าสุด [8, 11, DNF, 9, 12] → DNF = ช้าสุด, ตัด 8 กับ DNF ออก
//            = (11+9+12)/3 = 32/3 = 10.666… → ปัดครึ่งขึ้น = 10.67
//   ao12   = null (มีแค่ 7 ครั้ง)       ao100 = null
//   สตรีค  = ชนะ ชนะ แพ้ ชนะ ชนะ ชนะ แพ้ (เก่า→ใหม่) → current 2 · best 3
//
// สัปดาห์นี้ นับเฉพาะห้องที่ปรับคะแนน: +16, +12, −14 → รวม +14 · 3 แมตช์ · ชนะ 2 แพ้ 1 · เร็วสุด 8.00

const EXPECTED_STATS = {
  totalSolves: 7,
  totalMatches: 7,
  wins: 5,
  losses: 2,
  draws: 0,
  winRate: 0.7143,
  dnfCount: 1,
  best: 8,
  worst: 20,
  mean: 12.5,
  ao5: 10.67,
  ao12: null,
  ao100: null,
  currentStreak: 2,
  bestStreak: 3,
};

const EXPECTED_WEEKLY = {
  eloChange: 14,
  matchesPlayed: 3,
  wins: 2,
  losses: 1,
  bestTime: 8,
};

// ---------------------------------------------------------------- ตัวช่วย

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  return (await res.json()) as T;
}

interface Paged<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number } & Record<string, unknown>;
}

/** ตามหาแถวของผู้ใช้บนกระดาน — ไล่ทีละหน้าเพราะอาจมีข้อมูลอื่นในฐานปนอยู่ */
async function findOnLeaderboard(
  scope: 'all' | 'weekly',
  userId: number,
): Promise<{ row: Record<string, number | string | null> | undefined; meta: Paged<never>['meta'] }> {
  let meta: Paged<never>['meta'] = { page: 1, limit: 100, total: 0, totalPages: 1 };

  for (let page = 1; page <= 10; page++) {
    const body = await getJson<Paged<Record<string, number | string | null>>>(
      `/leaderboard?cubeType=${CUBE_TYPE}&scope=${scope}&page=${page}&limit=100`,
    );
    meta = body.meta;
    const row = body.data?.find((r) => r.userId === userId);
    if (row) return { row, meta };
    if (page >= (body.meta?.totalPages ?? 1)) break;
  }
  return { row: undefined, meta };
}

// ---------------------------------------------------------------- fixture

interface Fixture {
  userIds: Record<(typeof FIXTURE_USERNAMES)[number], number>;
  matchIds: number[];
  multiplayerMatchIds: number[];
  ratingBackup: { userId: number; data: Prisma.RatingUncheckedCreateInput }[];
}

/** ลบแมตช์ pyramorphix ของผู้ใช้ชุดนี้ทิ้งให้หมด เพื่อให้รันซ้ำได้ผลเดิมทุกครั้ง */
async function wipeExisting(userIds: number[]): Promise<void> {
  const matches = await prisma.match.findMany({
    where: {
      cubeType: PRISMA_CUBE_TYPE,
      OR: [{ player1Id: { in: userIds } }, { player2Id: { in: userIds } }],
    },
    select: { matchId: true },
  });
  const multis = await prisma.multiplayerMatch.findMany({
    where: { cubeType: PRISMA_CUBE_TYPE, participants: { some: { userId: { in: userIds } } } },
    select: { multiplayerMatchId: true },
  });

  const matchIds = matches.map((m) => m.matchId);
  const multiIds = multis.map((m) => m.multiplayerMatchId);

  // MatchFlag / Report ตั้ง onDelete: Restrict ไว้ → ต้องเก็บของที่อ้างถึงออกก่อน
  await prisma.matchFlag.deleteMany({
    where: { OR: [{ matchId: { in: matchIds } }, { multiplayerMatchId: { in: multiIds } }] },
  });
  await prisma.report.deleteMany({
    where: { OR: [{ matchId: { in: matchIds } }, { multiplayerMatchId: { in: multiIds } }] },
  });
  await prisma.match.deleteMany({ where: { matchId: { in: matchIds } } });
  await prisma.multiplayerMatch.deleteMany({ where: { multiplayerMatchId: { in: multiIds } } });
}

async function buildFixture(): Promise<Fixture> {
  const users = await prisma.user.findMany({
    where: { username: { in: [...FIXTURE_USERNAMES] } },
    select: { userId: true, username: true },
  });
  if (users.length !== FIXTURE_USERNAMES.length) {
    throw new Error(`ต้อง seed ผู้ใช้ ${FIXTURE_USERNAMES.join(', ')} ก่อน (npm run seed)`);
  }

  const userIds = Object.fromEntries(
    FIXTURE_USERNAMES.map((name) => [name, users.find((u) => u.username === name)!.userId]),
  ) as Fixture['userIds'];
  const ids = Object.values(userIds);

  const ratingBackup = (
    await prisma.rating.findMany({ where: { userId: { in: ids }, cubeType: PRISMA_CUBE_TYPE } })
  ).map((r) => ({ userId: r.userId, data: r as unknown as Prisma.RatingUncheckedCreateInput }));

  await wipeExisting(ids);

  const week = weekRangeOf();
  const me = userIds.somchai;
  const foe = userIds.malee;

  /** แมตช์ 1v1 ที่ somchai เป็น player1 เสมอ — เวลา/ผล/elo กำหนดตายตัวตามตารางด้านบน */
  const singles = [
    // สัปดาห์นี้
    { at: new Date(week.start.getTime() + 3 * HOUR), mine: 8, theirs: 13, elo: 16, rated: true },
    { at: new Date(week.start.getTime() + 1 * HOUR), mine: null, theirs: 17, elo: -14, rated: true },
    // สัปดาห์ที่แล้ว
    { at: new Date(week.start.getTime() - 24 * HOUR), mine: 9, theirs: 14, elo: null, rated: false },
    { at: new Date(week.start.getTime() - 25 * HOUR), mine: 12, theirs: 19, elo: 10, rated: true },
    { at: new Date(week.start.getTime() - 26 * HOUR), mine: 15, theirs: 21, elo: 9, rated: true },
    { at: new Date(week.start.getTime() - 27 * HOUR), mine: 20, theirs: 16, elo: -11, rated: true },
  ];

  const matchIds: number[] = [];
  for (const s of singles) {
    const iWon = s.mine !== null && s.mine < s.theirs;
    const row = await prisma.match.create({
      data: {
        roomType: s.rated ? RoomType.COMPETITIVE : RoomType.CUSTOM,
        cubeType: PRISMA_CUBE_TYPE,
        player1Id: me,
        player2Id: foe,
        scramble: "R U R' U' F2",
        player1Time: s.mine === null ? null : dec(s.mine),
        player2Time: dec(s.theirs),
        player1Result: s.mine === null ? SolveResult.DNF : SolveResult.SOLVED,
        player2Result: SolveResult.SOLVED,
        // จำนวน move ของฉันคงที่ทุกแมตช์ เพื่อให้ยืนยัน `moveCount` ในประวัติได้ (ADR-047 ข้อ 1)
        player1MoveCount: 60,
        player2MoveCount: 72,
        player1EloBefore: s.rated ? 1000 : null,
        player2EloBefore: s.rated ? 1000 : null,
        player1EloChange: s.elo,
        player2EloChange: s.elo === null ? null : -s.elo,
        winnerId: iWon ? me : foe,
        startedAt: s.at,
        finishedAt: s.at,
      },
      select: { matchId: true },
    });
    matchIds.push(row.matchId);
  }

  // แมตช์หลายคนของสัปดาห์นี้ — somchai ชนะด้วย 11.00 · nattapong DNF ได้อันดับท้ายสุด
  const multi = await prisma.multiplayerMatch.create({
    data: {
      cubeType: PRISMA_CUBE_TYPE,
      roomMode: RoomMode.AUTO,
      scramble: "R U R' U' F2",
      playerCount: 3,
      startedAt: new Date(week.start.getTime() + 2 * HOUR),
      finishedAt: new Date(week.start.getTime() + 2 * HOUR),
      participants: {
        create: [
          { userId: me, solveTime: dec(11), result: SolveResult.SOLVED, rankNo: 1, eloBefore: 1000, eloChange: 12, moveCount: 74 },
          { userId: userIds.pimchanok, solveTime: dec(18), result: SolveResult.SOLVED, rankNo: 2, eloBefore: 1000, eloChange: -4 },
          { userId: userIds.nattapong, solveTime: null, result: SolveResult.DNF, rankNo: 3, eloBefore: 1000, eloChange: -8 },
        ],
      },
    },
    select: { multiplayerMatchId: true },
  });

  // `/stats` อ่าน wins/losses/draws จากตาราง `Rating` (ADR-045 ข้อ 3) → ตั้งให้ตรงกับ fixture
  await prisma.rating.update({
    where: { userId_cubeType: { userId: me, cubeType: PRISMA_CUBE_TYPE } },
    data: {
      matchesPlayed: EXPECTED_STATS.totalMatches,
      wins: EXPECTED_STATS.wins,
      losses: EXPECTED_STATS.losses,
      draws: EXPECTED_STATS.draws,
      bestTime: dec(EXPECTED_STATS.best),
    },
  });

  return { userIds, matchIds, multiplayerMatchIds: [multi.multiplayerMatchId], ratingBackup };
}

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.match.deleteMany({ where: { matchId: { in: fx.matchIds } } });
  await prisma.multiplayerMatch.deleteMany({
    where: { multiplayerMatchId: { in: fx.multiplayerMatchIds } },
  });
  for (const backup of fx.ratingBackup) {
    await prisma.rating.update({
      where: { userId_cubeType: { userId: backup.userId, cubeType: PRISMA_CUBE_TYPE } },
      data: backup.data,
    });
  }
}

// ---------------------------------------------------------------- การตรวจ

interface StatsBody {
  data: Record<string, number | string | null>;
}

async function checkStats(me: number): Promise<void> {
  console.log('\n📊 GET /users/:userId/stats');
  const body = await getJson<StatsBody>(`/users/${me}/stats?cubeType=${CUBE_TYPE}`);
  const got = body.data;
  if (!got) {
    check('เรียก /stats ได้', false, body);
    return;
  }

  for (const [field, want] of Object.entries(EXPECTED_STATS)) {
    check(`${field} = ${want}`, got[field] === want, `ได้ ${JSON.stringify(got[field])}`);
  }
}

interface HistoryRow {
  kind: '1v1' | 'multiplayer';
  myTime: number | null;
  moveCount: number | null;
  roomType?: string;
  roomMode?: string;
  result: string;
  eloChange: number | null;
  startedAt: string;
}

async function checkHistory(me: number): Promise<void> {
  console.log('\n🗂  GET /users/:userId/matches');

  const all = await getJson<Paged<HistoryRow>>(`/users/${me}/matches?cubeType=${CUBE_TYPE}&limit=50`);
  check('มีครบ 7 แมตช์', all.meta?.total === 7, all.meta);

  const times = all.data?.map((r) => r.myTime);
  check(
    'เรียงใหม่→เก่า และคละสองระบบแมตช์ถูกต้อง',
    JSON.stringify(times) === JSON.stringify([8, 11, null, 9, 12, 15, 20]),
    times,
  );
  check('แมตช์ที่ 2 มาจากห้องหลายคน', all.data?.[1]?.kind === 'multiplayer', all.data?.[1]?.kind);
  // `moveCount` ต้องเป็นของ **ผู้ใช้ในพาธ** ไม่ใช่ของคู่ต่อสู้ (fixture ตั้งไว้ 60 กับ 72)
  check('moveCount ของ 1v1 เป็นของตัวเอง', all.data?.[0]?.moveCount === 60, all.data?.[0]?.moveCount);
  check('moveCount ของห้องหลายคนมาด้วย', all.data?.[1]?.moveCount === 74, all.data?.[1]?.moveCount);
  check('แมตช์ที่ 1 เป็น 1v1 ห้องแข่งขัน', all.data?.[0]?.roomType === 'competitive', all.data?.[0]);

  const multiOnly = await getJson<Paged<HistoryRow>>(
    `/users/${me}/matches?cubeType=${CUBE_TYPE}&kind=multiplayer`,
  );
  check('?kind=multiplayer เหลือ 1 แมตช์', multiOnly.meta?.total === 1, multiOnly.meta);

  // `roomType=custom` แปลว่า "ห้องที่ไม่ปรับคะแนน" ครอบทั้งสองระบบ (ADR-045 ข้อ 4)
  const custom = await getJson<Paged<HistoryRow>>(
    `/users/${me}/matches?cubeType=${CUBE_TYPE}&roomType=custom`,
  );
  check('?roomType=custom เหลือ 1 แมตช์ที่ไม่ปรับคะแนน', custom.meta?.total === 1, custom.meta);
  check('แมตช์นั้น eloChange เป็น null', custom.data?.[0]?.eloChange === null, custom.data?.[0]);

  const page2 = await getJson<Paged<HistoryRow>>(
    `/users/${me}/matches?cubeType=${CUBE_TYPE}&page=2&limit=5`,
  );
  check('แบ่งหน้า: หน้า 2 ที่ limit=5 เหลือ 2 แถว', page2.data?.length === 2, page2.data?.length);
  check('หน้า 2 ต่อจากหน้า 1 ถูกต้อง (15.00 แล้ว 20.00)',
    JSON.stringify(page2.data?.map((r) => r.myTime)) === JSON.stringify([15, 20]),
    page2.data?.map((r) => r.myTime));
}

async function checkWeekly(me: number): Promise<void> {
  console.log('\n🏆 GET /leaderboard?scope=weekly');

  const { row, meta } = await findOnLeaderboard('weekly', me);
  if (!row) {
    check('เจอ somchai บนกระดานรายสัปดาห์', false, meta);
    return;
  }

  for (const [field, want] of Object.entries(EXPECTED_WEEKLY)) {
    check(`${field} = ${want}`, row[field] === want, `ได้ ${JSON.stringify(row[field])}`);
  }

  const week = weekRangeOf();
  check(
    'meta.weekStart = จันทร์ 00:00 ไทย (= อาทิตย์ 17:00 UTC)',
    meta.weekStart === week.start.toISOString(),
    meta.weekStart,
  );
  check('meta.scope = weekly', meta.scope === 'weekly', meta.scope);

  // กระดานต้องเรียงจาก eloChange มากไปน้อย ตรวจทั้งหน้าแรกกันพลาด
  const first = await getJson<Paged<{ eloChange: number; rank: number }>>(
    `/leaderboard?cubeType=${CUBE_TYPE}&scope=weekly&limit=100`,
  );
  const deltas = first.data?.map((r) => r.eloChange) ?? [];
  check(
    'เรียงตามผลรวม elo_change จากมากไปน้อย',
    deltas.every((v, i) => i === 0 || deltas[i - 1]! >= v),
    deltas.slice(0, 10),
  );
  check('rank เริ่มที่ 1 และไล่ทีละ 1', first.data?.[0]?.rank === 1, first.data?.[0]);
}

/**
 * cache 60 วินาที — เพิ่มแมตช์เข้าไปใหม่แล้วยิงซ้ำทันที ตัวเลขต้อง **ไม่ขยับ**
 * (ถ้าขยับแปลว่ายิง query ใหม่ทุก request ซึ่งผิดข้อกำหนดใน api-contract.md ข้อ 5)
 */
async function checkCache(fx: Fixture): Promise<void> {
  console.log('\n⏱  cache 60 วินาทีของกระดานรายสัปดาห์');
  const me = fx.userIds.somchai;
  const week = weekRangeOf();

  const extra = await prisma.match.create({
    data: {
      roomType: RoomType.COMPETITIVE,
      cubeType: PRISMA_CUBE_TYPE,
      player1Id: me,
      player2Id: fx.userIds.malee,
      scramble: "R U R' U' F2",
      player1Time: dec(7),
      player2Time: dec(30),
      player1Result: SolveResult.SOLVED,
      player2Result: SolveResult.SOLVED,
      player1EloBefore: 1000,
      player2EloBefore: 1000,
      player1EloChange: 50,
      player2EloChange: -50,
      winnerId: me,
      startedAt: new Date(week.start.getTime() + 4 * HOUR),
    },
    select: { matchId: true },
  });

  const { row } = await findOnLeaderboard('weekly', me);
  check(
    'เพิ่มแมตช์ใหม่แล้วยิงซ้ำทันที ค่ายังเป็นค่าเดิม (แปลว่า cache ทำงาน)',
    row?.eloChange === EXPECTED_WEEKLY.eloChange,
    `ได้ ${JSON.stringify(row?.eloChange)} — ถ้าเป็น ${EXPECTED_WEEKLY.eloChange + 50} แปลว่าไม่ได้ cache`,
  );

  await prisma.match.delete({ where: { matchId: extra.matchId } });
}

async function checkAllTimeStillWorks(me: number): Promise<void> {
  console.log('\n📋 GET /leaderboard?scope=all (ของเดิมต้องไม่พัง)');
  const { row } = await findOnLeaderboard('all', me);
  check('ยังเจอ somchai บนกระดานรวม', row !== undefined);
  check('ตัวเลขมาจากตาราง Rating', row?.matchesPlayed === EXPECTED_STATS.totalMatches, row);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log('🧪 สโมคเทสสถิติ + กระดานอันดับรายสัปดาห์');

  const fx = await buildFixture();
  console.log(`  📝 ใส่ fixture แล้ว: 1v1 ${fx.matchIds.length} แมตช์ + หลายคน 1 แมตช์`);

  try {
    await checkStats(fx.userIds.somchai);
    await checkHistory(fx.userIds.somchai);
    await checkWeekly(fx.userIds.somchai);
    await checkCache(fx);
    await checkAllTimeStillWorks(fx.userIds.somchai);
  } finally {
    await cleanup(fx);
    console.log('\n  🧹 ลบ fixture และคืนค่า Rating เรียบร้อย');
  }

  const code = summary('(กระดานรายสัปดาห์จะยัง cache ค่าเก่าอีกไม่เกิน 60 วิหลังจากนี้)');
  await prisma.$disconnect();
  process.exit(code);
}

main().catch(async (error: unknown) => {
  console.error('\n💥 ทดสอบล้ม:', error);
  await prisma.$disconnect();
  process.exit(1);
});
