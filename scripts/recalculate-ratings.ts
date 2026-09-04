/**
 * ซ่อมตัวเลขสรุปใน Rating (matches_played / wins / losses / draws / best_time)
 * โดยคำนวณใหม่จากข้อมูลจริงใน Match + MultiplayerMatchParticipant — ดู ADR-014
 *
 * ตัวเลขพวกนี้เป็นข้อมูลซ้ำซ้อน (denormalized) ที่ปกติต้องอัปเดตในทรานแซกชันเดียวกับ
 * ตอนบันทึกผลแมตช์ สคริปต์นี้มีไว้ซ่อมเมื่อมันเพี้ยน ไม่ใช่ของที่ต้องรันประจำ
 *
 * รัน:  npx tsx scripts/recalculate-ratings.ts           (dry-run — แสดงส่วนต่างอย่างเดียว)
 *       npx tsx scripts/recalculate-ratings.ts --apply   (เขียนลง DB จริง)
 *
 * ⚠️ ไม่แตะคอลัมน์ elo_rating — Elo คำนวณย้อนหลังจากผลแมตช์ไม่ได้ถ้าไม่มี elo_before/elo_change
 *    ครบทุกแถว และการไล่คำนวณใหม่ตามลำดับเวลาเป็นงานคนละชิ้น (ถ้าจำเป็นค่อยเขียนแยก)
 *
 * นับอะไรบ้าง:
 *   - นับ **ทุกแมตช์ที่บันทึกลง DB** ทั้ง room_type = COMPETITIVE และ CUSTOM
 *     (ให้ตรงกับกฎของ best_time ใน database-schema.md ที่ว่า "นับเฉพาะแมตช์ที่บันทึก DB
 *     — ห้องฝึกซ้อมไม่นับ" ซึ่งห้องฝึกซ้อมไม่มีแถวใน DB อยู่แล้ว)
 *   - ห้องหลายคน: rank_no = 1 คือชนะ, ถ้ามีคนได้ rank_no = 1 มากกว่าหนึ่งคนถือว่าเสมอ
 *     (เวลาเท่ากันเป๊ะ ตาม game-rules.md ข้อ 7)
 *   - best_time นับเฉพาะ solve ที่ result = SOLVED (เวลาที่เป็น NULL คือ DNF/DNS เสมอ)
 */
import { PrismaClient, CubeType, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

type Tally = {
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  bestTime: Prisma.Decimal | null;
};

const emptyTally = (): Tally => ({
  matchesPlayed: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  bestTime: null,
});

/** key ของ map = `${userId}:${cubeType}` ให้ตรงกับ composite PK ของ Rating */
const key = (userId: number, cubeType: CubeType) => `${userId}:${cubeType}`;

function bestOf(current: Prisma.Decimal | null, candidate: Prisma.Decimal | null) {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return candidate.lessThan(current) ? candidate : current;
}

async function buildTallies(): Promise<Map<string, Tally>> {
  const tallies = new Map<string, Tally>();
  const get = (userId: number, cubeType: CubeType) => {
    const k = key(userId, cubeType);
    let t = tallies.get(k);
    if (!t) {
      t = emptyTally();
      tallies.set(k, t);
    }
    return t;
  };

  // ---------- แมตช์ 1v1 ----------
  const matches = await prisma.match.findMany({
    select: {
      cubeType: true,
      player1Id: true,
      player2Id: true,
      player1Time: true,
      player2Time: true,
      player1Result: true,
      player2Result: true,
      winnerId: true,
    },
  });

  for (const m of matches) {
    const sides = [
      { userId: m.player1Id, time: m.player1Time, result: m.player1Result },
      { userId: m.player2Id, time: m.player2Time, result: m.player2Result },
    ];
    for (const side of sides) {
      const t = get(side.userId, m.cubeType);
      t.matchesPlayed += 1;
      // winner_id = NULL หมายถึงเสมอ ไม่ใช่ "ยังไม่จบ" — แถวจะถูกเขียนก็ต่อเมื่อแมตช์จบแล้ว
      if (m.winnerId === null) t.draws += 1;
      else if (m.winnerId === side.userId) t.wins += 1;
      else t.losses += 1;

      if (side.result === 'SOLVED') t.bestTime = bestOf(t.bestTime, side.time);
    }
  }

  // ---------- แมตช์หลายคน ----------
  const participants = await prisma.multiplayerMatchParticipant.findMany({
    select: {
      multiplayerMatchId: true,
      userId: true,
      solveTime: true,
      result: true,
      rankNo: true,
      match: { select: { cubeType: true } },
    },
  });

  // นับว่าแต่ละแมตช์มีคนได้อันดับ 1 กี่คน (มากกว่า 1 = เสมอที่หัวตาราง)
  const firstPlaceCount = new Map<number, number>();
  for (const p of participants) {
    if (p.rankNo === 1) {
      firstPlaceCount.set(p.multiplayerMatchId, (firstPlaceCount.get(p.multiplayerMatchId) ?? 0) + 1);
    }
  }

  for (const p of participants) {
    const t = get(p.userId, p.match.cubeType);
    t.matchesPlayed += 1;
    if (p.rankNo === 1) {
      if ((firstPlaceCount.get(p.multiplayerMatchId) ?? 0) > 1) t.draws += 1;
      else t.wins += 1;
    } else {
      t.losses += 1;
    }

    if (p.result === 'SOLVED') t.bestTime = bestOf(t.bestTime, p.solveTime);
  }

  return tallies;
}

function sameTime(a: Prisma.Decimal | null, b: Prisma.Decimal | null) {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

async function main() {
  const tallies = await buildTallies();
  const ratings = await prisma.rating.findMany();

  const drifted: { userId: number; cubeType: CubeType; from: Tally; to: Tally }[] = [];

  for (const r of ratings) {
    const expected = tallies.get(key(r.userId, r.cubeType)) ?? emptyTally();
    const drift =
      r.matchesPlayed !== expected.matchesPlayed ||
      r.wins !== expected.wins ||
      r.losses !== expected.losses ||
      r.draws !== expected.draws ||
      !sameTime(r.bestTime, expected.bestTime);

    if (drift) {
      drifted.push({
        userId: r.userId,
        cubeType: r.cubeType,
        from: {
          matchesPlayed: r.matchesPlayed,
          wins: r.wins,
          losses: r.losses,
          draws: r.draws,
          bestTime: r.bestTime,
        },
        to: expected,
      });
    }
  }

  // แถวที่มีผลแมตช์จริงแต่ไม่มีแถว Rating รองรับ = ข้อมูลผิดรูป ต้องให้คนดู ไม่ซ่อมเงียบ ๆ
  const ratingKeys = new Set(ratings.map((r) => key(r.userId, r.cubeType)));
  const orphans = [...tallies.keys()].filter((k) => !ratingKeys.has(k));

  console.log(`[recalculate-ratings] ตรวจ Rating ${ratings.length} แถว · เพี้ยน ${drifted.length} แถว`);
  for (const d of drifted) {
    console.log(
      `  user ${d.userId} / ${d.cubeType}: ` +
        `played ${d.from.matchesPlayed}→${d.to.matchesPlayed} · ` +
        `W ${d.from.wins}→${d.to.wins} · L ${d.from.losses}→${d.to.losses} · ` +
        `D ${d.from.draws}→${d.to.draws} · best ${d.from.bestTime ?? '-'}→${d.to.bestTime ?? '-'}`,
    );
  }
  if (orphans.length > 0) {
    console.warn(
      `[recalculate-ratings] ⚠️ มีผลแมตช์ของ ${orphans.length} คู่ (user, cube_type) ที่ไม่มีแถว Rating: ${orphans.join(', ')}`,
    );
  }

  if (!APPLY) {
    console.log('[recalculate-ratings] dry-run — ยังไม่เขียนลง DB (ใส่ --apply เพื่อเขียนจริง)');
    return;
  }

  if (drifted.length === 0) {
    console.log('[recalculate-ratings] ไม่มีอะไรต้องแก้');
    return;
  }

  await prisma.$transaction(
    drifted.map((d) =>
      prisma.rating.update({
        where: { userId_cubeType: { userId: d.userId, cubeType: d.cubeType } },
        data: {
          matchesPlayed: d.to.matchesPlayed,
          wins: d.to.wins,
          losses: d.to.losses,
          draws: d.to.draws,
          bestTime: d.to.bestTime,
        },
      }),
    ),
  );
  console.log(`[recalculate-ratings] เขียนแล้ว ${drifted.length} แถว`);
}

main()
  .catch((e) => {
    console.error('[recalculate-ratings] ล้มเหลว:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
