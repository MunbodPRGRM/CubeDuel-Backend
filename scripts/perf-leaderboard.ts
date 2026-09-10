/**
 * วัดผล query ของกระดานอันดับ/สถิติตอนข้อมูลเยอะ — เฟส 7 ก้อนที่ 2
 *
 * รัน:
 *   npx tsx scripts/perf-leaderboard.ts --seed            seed ผู้ใช้ + แมตช์ปลอมจำนวนมาก
 *   npx tsx scripts/perf-leaderboard.ts                   วัดอย่างเดียว (EXPLAIN ANALYZE + จับเวลา)
 *   npx tsx scripts/perf-leaderboard.ts --clean           ลบข้อมูลปลอมทิ้ง
 *
 * ปรับจำนวนได้ด้วย env:  PERF_USERS=2000 PERF_MATCHES=50000 PERF_MULTI=5000
 *
 * ⚠️ ข้อมูลที่ script นี้สร้างเป็น **ข้อมูลขยะสำหรับวัดผลเท่านั้น** — ผู้ใช้ทุกคนที่สร้างขึ้น
 *    ใช้ username ขึ้นต้นด้วย `perf_` และ `--clean` ลบเฉพาะพวกนั้น ของ seed ปกติไม่โดน
 *    อย่ารันกับฐานข้อมูลจริง
 */
import { CubeType, PrismaClient, Prisma, RoomMode, RoomType, SolveResult } from '@prisma/client';
import { weekRangeOf } from '../src/lib/week.js';
import { weeklySql } from '../src/services/weekly-leaderboard.service.js';

const prisma = new PrismaClient();

const USERS = Number(process.env.PERF_USERS ?? 2_000);
const MATCHES = Number(process.env.PERF_MATCHES ?? 50_000);
const MULTI = Number(process.env.PERF_MULTI ?? 5_000);

const PREFIX = 'perf_';
const CUBE_TYPES = [
  CubeType.CUBE_2X2X2,
  CubeType.CUBE_3X3X3,
  CubeType.PYRAMINX,
  CubeType.PYRAMORPHIX,
];

/** สุ่มแบบมี seed คงที่ — รันสองครั้งได้ข้อมูลชุดเดิม เทียบผลกันได้ */
let rngState = 20260910;
function rand(): number {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const intBetween = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

/**
 * กระจาย `started_at` ให้ ~1 ใน 8 ตกอยู่ในสัปดาห์ปัจจุบัน ที่เหลือย้อนหลังไปหนึ่งปี
 * — ถ้าเทกองไว้ในสัปดาห์เดียวหมด index `(cube_type, started_at)` จะดูเหมือนไม่ช่วยอะไร
 */
function randomStartedAt(): Date {
  const week = weekRangeOf();
  if (rand() < 0.125) {
    return new Date(week.start.getTime() + rand() * (Date.now() - week.start.getTime()));
  }
  const yearAgo = week.start.getTime() - 365 * 24 * 60 * 60 * 1000;
  return new Date(yearAgo + rand() * (week.start.getTime() - yearAgo));
}

async function seedUsers(): Promise<number[]> {
  const existing = await prisma.user.findMany({
    where: { username: { startsWith: PREFIX } },
    select: { userId: true },
  });
  if (existing.length >= USERS) {
    console.log(`[perf] มีผู้ใช้ ${PREFIX}* อยู่แล้ว ${existing.length} คน — ข้ามการสร้าง`);
    return existing.map((u) => u.userId);
  }

  console.log(`[perf] สร้างผู้ใช้ ${USERS} คน...`);
  for (let start = existing.length; start < USERS; start += 500) {
    const batch = Array.from({ length: Math.min(500, USERS - start) }, (_, i) => ({
      username: `${PREFIX}${start + i}`,
      email: `${PREFIX}${start + i}@perf.local`,
      // ไม่ต้อง hash จริง — ข้อมูลชุดนี้ล็อกอินไม่ได้และไม่ควรล็อกอินได้
      passwordHash: null,
      nickname: `Perf ${start + i}`,
    }));
    await prisma.user.createMany({ data: batch, skipDuplicates: true });
  }

  const users = await prisma.user.findMany({
    where: { username: { startsWith: PREFIX } },
    select: { userId: true },
  });

  await prisma.rating.createMany({
    data: users.flatMap((u) =>
      CUBE_TYPES.map((cubeType) => ({
        userId: u.userId,
        cubeType,
        eloRating: intBetween(700, 1600),
      })),
    ),
    skipDuplicates: true,
  });

  return users.map((u) => u.userId);
}

const decimal = (seconds: number) => new Prisma.Decimal(seconds.toFixed(2));

async function seedMatches(userIds: number[]): Promise<void> {
  const have = await prisma.match.count();
  console.log(`[perf] สร้างแมตช์ 1v1 อีก ${MATCHES} แถว (ตอนนี้มี ${have})...`);

  for (let done = 0; done < MATCHES; done += 1_000) {
    const rows = Array.from({ length: Math.min(1_000, MATCHES - done) }, () => {
      const p1 = pick(userIds);
      let p2 = pick(userIds);
      while (p2 === p1) p2 = pick(userIds);

      const competitive = rand() < 0.8;
      const t1 = rand() < 0.06 ? null : 5 + rand() * 40;
      const t2 = rand() < 0.06 ? null : 5 + rand() * 40;
      // ผู้ชนะตัดสินจากเวลา — DNF แพ้เสมอ · ทั้งคู่ DNF = ไม่มีผู้ชนะ (เสมอ)
      const winnerId =
        t1 !== null && (t2 === null || t1 < t2) ? p1 : t2 !== null && (t1 === null || t2 < t1) ? p2 : null;
      const delta = intBetween(8, 24);

      return {
        roomType: competitive ? RoomType.COMPETITIVE : RoomType.CUSTOM,
        cubeType: pick(CUBE_TYPES),
        player1Id: p1,
        player2Id: p2,
        scramble: "R U R' U' F2 L D",
        player1Time: t1 === null ? null : decimal(t1),
        player2Time: t2 === null ? null : decimal(t2),
        player1Result: t1 === null ? SolveResult.DNF : SolveResult.SOLVED,
        player2Result: t2 === null ? SolveResult.DNF : SolveResult.SOLVED,
        player1EloBefore: competitive ? 1000 : null,
        player2EloBefore: competitive ? 1000 : null,
        player1EloChange: competitive ? (winnerId === p1 ? delta : winnerId === null ? 0 : -delta) : null,
        player2EloChange: competitive ? (winnerId === p2 ? delta : winnerId === null ? 0 : -delta) : null,
        winnerId,
        startedAt: randomStartedAt(),
      };
    });

    await prisma.match.createMany({ data: rows });
    process.stdout.write(`\r  ${done + rows.length}/${MATCHES}`);
  }
  console.log('');
}

async function seedMultiplayer(userIds: number[]): Promise<void> {
  console.log(`[perf] สร้างแมตช์หลายคนอีก ${MULTI} แถว...`);

  for (let done = 0; done < MULTI; done += 250) {
    const batch = Math.min(250, MULTI - done);

    await prisma.$transaction(
      Array.from({ length: batch }, () => {
        const playerCount = rand() < 0.5 ? 3 : 4;
        const auto = rand() < 0.8;

        const players: number[] = [];
        while (players.length < playerCount) {
          const candidate = pick(userIds);
          if (!players.includes(candidate)) players.push(candidate);
        }

        const times = players.map(() => (rand() < 0.08 ? null : 5 + rand() * 40));
        // อันดับ: แก้สำเร็จเรียงตามเวลา · DNF ไปอยู่ท้ายสุดร่วมกัน (game-rules.md ข้อ 7)
        const solved = times
          .map((t, i) => ({ t, i }))
          .filter((x): x is { t: number; i: number } => x.t !== null)
          .sort((a, b) => a.t - b.t);
        const rankOf = new Map<number, number>();
        solved.forEach((x, order) => rankOf.set(x.i, order + 1));
        times.forEach((t, i) => {
          if (t === null) rankOf.set(i, solved.length + 1);
        });

        return prisma.multiplayerMatch.create({
          data: {
            cubeType: pick(CUBE_TYPES),
            roomMode: auto ? RoomMode.AUTO : RoomMode.CUSTOM,
            scramble: "R U R' U' F2 L D",
            playerCount,
            startedAt: randomStartedAt(),
            participants: {
              create: players.map((userId, i) => ({
                userId,
                solveTime: times[i] === null ? null : decimal(times[i]!),
                result: times[i] === null ? SolveResult.DNF : SolveResult.SOLVED,
                rankNo: rankOf.get(i)!,
                eloBefore: auto ? 1000 : null,
                eloChange: auto ? intBetween(-20, 20) : null,
              })),
            },
          },
        });
      }),
    );
    process.stdout.write(`\r  ${done + batch}/${MULTI}`);
  }
  console.log('');
}

// ------------------------------------------------------------------ วัดผล

/** อ่านบรรทัดที่บอกวิธีเข้าถึงตารางออกจากแผน EXPLAIN — ที่สนใจคือมี Seq Scan ตารางใหญ่ไหม */
function scanLines(plan: string[]): string[] {
  return plan
    .map((line) => line.trim())
    .filter((line) => /Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Bitmap Index Scan/.test(line));
}

async function planOf(sql: Prisma.Sql): Promise<{ lines: string[]; ms: number }> {
  const rows = await prisma.$queryRaw<Record<string, string>[]>(
    Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
  );
  const lines = rows.map((r) => Object.values(r)[0]!);
  const time = lines.find((l) => l.trim().startsWith('Execution Time'));
  return { lines, ms: Number(/([\d.]+) ms/.exec(time ?? '')?.[1] ?? NaN) };
}

async function explain(label: string, sql: Prisma.Sql): Promise<void> {
  const { lines, ms } = await planOf(sql);

  console.log(`\n── ${label}`);
  for (const line of scanLines(lines)) console.log(`   ${line}`);
  console.log(`   Execution Time: ${ms.toFixed(3)} ms`);

  const seq = scanLines(lines).filter((l) => /Seq Scan on "?(Match|Multiplayer|Rating)/i.test(l));
  if (seq.length === 0) return;

  console.log(`   ⚠️  planner เลือก Seq Scan บนตารางใหญ่: ${seq.join(' | ')}`);

  // ลองบังคับให้ใช้ index ดูว่าจริง ๆ แล้วเร็วกว่าไหม — ถ้าเร็วกว่าแปลว่า "index มีแต่ planner ไม่เลือก"
  // ซึ่งแก้ด้วยการเพิ่ม index ไม่ได้ ต้องไปปรับ random_page_cost ฝั่ง server (ADR-046 ข้อ 5)
  await prisma.$executeRawUnsafe('SET enable_seqscan = off');
  const forced = await planOf(sql);
  await prisma.$executeRawUnsafe('SET enable_seqscan = on');

  console.log(`   ↳ บังคับใช้ index แล้วได้ ${forced.ms.toFixed(3)} ms (ต่างกัน ${(ms / forced.ms).toFixed(1)} เท่า)`);
  for (const line of scanLines(forced.lines)) console.log(`     ${line}`);
}

/**
 * `random_page_cost` ค่าเริ่มต้นของ Postgres คือ 4.0 ซึ่งตั้งมาสำหรับ **จานหมุน**
 * บน SSD ค่าที่ถูกคือราว 1.1 — ถ้าไม่ปรับ planner จะประเมินว่าอ่าน index แพงเกินจริง
 * แล้วเลือก Seq Scan ทั้งที่ index ที่ต้องใช้มีอยู่ครบ (ADR-046 ข้อ 5)
 */
async function randomPageCostCheck(sql: Prisma.Sql): Promise<void> {
  console.log('\n── ผลของ random_page_cost ต่อแผนเดิม (ปรับฝั่ง server ไม่ใช่ฝั่งโค้ด)');
  for (const cost of ['4.0', '1.1']) {
    await prisma.$executeRawUnsafe(`SET random_page_cost = ${cost}`);
    const { lines, ms } = await planOf(sql);
    const join = scanLines(lines).find((l) => /Participant/.test(l)) ?? '(ไม่พบบรรทัดที่แตะ participant)';
    console.log(`   random_page_cost = ${cost.padEnd(3)} → ${ms.toFixed(1)} ms · ${join}`);
  }
  await prisma.$executeRawUnsafe('RESET random_page_cost');
}

/** จับเวลาแบบที่ผู้ใช้เจอจริง (รวมค่าใช้จ่ายฝั่ง Node) — รันซ้ำแล้วเอาค่ากลาง */
async function timeIt(label: string, fn: () => Promise<unknown>, runs = 5): Promise<void> {
  await fn(); // อุ่นเครื่องก่อน ไม่นับรอบแรกที่ยังไม่มีอะไรอยู่ใน cache ของ Postgres
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  console.log(`   ⏱  ${label}: กลาง ${ms[Math.floor(runs / 2)]!.toFixed(1)} ms · ช้าสุด ${ms.at(-1)!.toFixed(1)} ms`);
}

async function measure(): Promise<void> {
  const [matches, participants, users] = await Promise.all([
    prisma.match.count(),
    prisma.multiplayerMatchParticipant.count(),
    prisma.user.count(),
  ]);
  console.log(`[perf] ข้อมูลที่มี: Match ${matches} · Participant ${participants} · User ${users}`);

  const week = weekRangeOf();
  const cubeType = '3x3x3';

  await explain(
    'Weekly: หา Match ของสัปดาห์นี้ (ต้องเข้า Match_cube_type_started_at_idx)',
    Prisma.sql`
      SELECT player1_id, player1_elo_change FROM "Match"
      WHERE cube_type = ${cubeType}::"CubeType" AND room_type = 'COMPETITIVE'
        AND started_at >= ${week.start} AND started_at < ${week.end}
    `,
  );

  await explain(
    'Weekly: join participant ของแมตช์หลายคนในสัปดาห์นี้',
    Prisma.sql`
      SELECT p.user_id, p.elo_change FROM "MultiplayerMatchParticipant" p
      JOIN "MultiplayerMatch" m ON m.multiplayer_match_id = p.multiplayer_match_id
      WHERE m.cube_type = ${cubeType}::"CubeType" AND m.room_mode = 'AUTO'
        AND m.started_at >= ${week.start} AND m.started_at < ${week.end}
    `,
  );

  // อันนี้คือ SQL ตัวเดียวกับที่ endpoint ใช้จริง ไม่ใช่ของจำลอง — import มาจาก service ตรง ๆ
  await explain('Weekly: SQL ทั้งก้อนที่ endpoint ใช้จริง', weeklySql(cubeType, week, 'elo'));
  await randomPageCostCheck(weeklySql(cubeType, week, 'elo'));

  await explain(
    'Leaderboard หลัก: Rating เรียงตาม elo (ต้องเข้า Rating_cube_type_elo_rating_idx)',
    Prisma.sql`
      SELECT user_id, elo_rating FROM "Rating"
      WHERE cube_type = ${cubeType}::"CubeType"
      ORDER BY elo_rating DESC LIMIT 50
    `,
  );

  // ประวัติของผู้ใช้ที่แมตช์เยอะที่สุด — เคสที่แย่ที่สุดของ /users/:userId/matches
  const busiest = await prisma.$queryRaw<{ user_id: number; n: bigint }[]>`
    SELECT player1_id AS user_id, COUNT(*) AS n FROM "Match"
    GROUP BY player1_id ORDER BY n DESC LIMIT 1
  `;
  const busiestId = busiest[0]?.user_id;

  if (busiestId !== undefined) {
    console.log(`\n[perf] ผู้ใช้ที่แมตช์เยอะที่สุด: userId ${busiestId} (${busiest[0]!.n} แมตช์ในช่อง player1)`);
    await explain(
      'ประวัติผู้ใช้: Match ฝั่ง player1 (ต้องเข้า Match_player1_id_started_at_idx)',
      Prisma.sql`
        SELECT match_id FROM "Match"
        WHERE player1_id = ${busiestId} ORDER BY started_at DESC
      `,
    );
  }

  console.log('\n── เวลาจริงที่ผู้ใช้เจอ (ไม่ผ่าน cache)');
  const { getWeeklyLeaderboard, clearWeeklyCache } = await import(
    '../src/services/weekly-leaderboard.service.js'
  );
  await timeIt('GET /leaderboard?scope=weekly (cache เย็นทุกครั้ง)', async () => {
    clearWeeklyCache();
    await getWeeklyLeaderboard(cubeType, 'elo');
  });
  await timeIt('GET /leaderboard?scope=weekly (cache ร้อน)', () =>
    getWeeklyLeaderboard(cubeType, 'elo'),
  );

  if (busiestId !== undefined) {
    const { getUserStats } = await import('../src/services/stats.service.js');
    await timeIt(`GET /users/${busiestId}/stats (ผู้ใช้ที่แมตช์เยอะที่สุด)`, () =>
      getUserStats(busiestId, cubeType),
    );
  }
}

async function clean(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { username: { startsWith: PREFIX } },
    select: { userId: true },
  });
  const ids = users.map((u) => u.userId);
  console.log(`[perf] ลบข้อมูลของผู้ใช้ ${PREFIX}* จำนวน ${ids.length} คน...`);

  // Match ตั้ง onDelete: Restrict ไว้ → ต้องลบแมตช์ก่อน ลบผู้ใช้ทีหลัง
  await prisma.match.deleteMany({
    where: { OR: [{ player1Id: { in: ids } }, { player2Id: { in: ids } }] },
  });
  await prisma.multiplayerMatch.deleteMany({
    where: { participants: { some: { userId: { in: ids } } } },
  });
  await prisma.rating.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { userId: { in: ids } } });
  console.log('[perf] ลบเรียบร้อย');
}

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) return clean();

  if (process.argv.includes('--seed')) {
    const userIds = await seedUsers();
    await seedMatches(userIds);
    await seedMultiplayer(userIds);
    // ไม่ ANALYZE = planner ยังคิดว่าตารางว่างอยู่ แล้วเลือก Seq Scan ทั้งที่มี index ให้ใช้
    await prisma.$executeRawUnsafe('ANALYZE "Match", "MultiplayerMatch", "MultiplayerMatchParticipant", "Rating"');
    console.log('[perf] seed + ANALYZE เสร็จ');
  }

  await measure();
}

main()
  .catch((e) => {
    console.error('[perf] ล้มเหลว:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
