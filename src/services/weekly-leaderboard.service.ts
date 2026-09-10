/**
 * กระดานอันดับรายสัปดาห์ — `docs/api-contract.md` ข้อ 5 (เฟส 7 ก้อนที่ 2)
 *
 * กติกาที่เอกสารกำหนดไว้:
 *   - คำนวณ **สดจาก `Match` + `MultiplayerMatchParticipant`** ไม่มีตารางเก็บ state ของตัวเอง
 *   - สัปดาห์เริ่มวันจันทร์ 00:00 เวลาไทย (ดู `lib/week.ts`)
 *   - จัดอันดับจาก **ผลรวม `elo_change` ในสัปดาห์นั้น** ไม่แตะ `Rating.elo_rating`
 *   - เป็น query ที่หนักที่สุดในระบบ → cache 60 วินาที
 *
 * ทำไมถึงเป็น raw SQL ทั้งที่ ADR-045 ข้อ 1 เลือกรวมสองตารางใน memory:
 * กรณีนั้นคือประวัติของผู้ใช้ **คนเดียว** (ไม่กี่พันแถว) แต่กระดานรายสัปดาห์กินแมตช์ของ
 * **ทุกคน** ในสัปดาห์นั้น — ขนมารวมที่ Node ไม่ได้ ต้องให้ฐานข้อมูลยุบเป็นแถวละคนก่อน
 * เหตุผลเต็มอยู่ใน ADR-046 ข้อ 2
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { TtlCache } from '../lib/cache.js';
import { winRateOf } from '../lib/stats.js';
import { weekKeyOf, weekRangeOf, type WeekRange } from '../lib/week.js';
import type { ApiCubeType } from '../types/cube.js';

/** อายุ cache ตามที่ `api-contract.md` ข้อ 5 กำหนด */
export const WEEKLY_CACHE_TTL_MS = 60_000;

/**
 * เพดานจำนวนอันดับที่กระดานรายสัปดาห์แสดง — กันไม่ให้ cache โตตามจำนวนผู้เล่นแบบไม่มีขีดจำกัด
 * (ADR-046 ข้อ 4) · อันดับที่ 1000 ของสัปดาห์ไม่มีใครเปิดดูอยู่แล้ว
 */
export const WEEKLY_MAX_ROWS = 1000;

export interface WeeklyLeaderboardRow {
  rank: number;
  userId: number;
  username: string;
  nickname: string | null;
  /** คะแนนปัจจุบันจากตาราง `Rating` — แสดงประกอบเฉย ๆ ไม่ได้ใช้จัดอันดับ */
  eloRating: number;
  /** ผลรวม `elo_change` ของสัปดาห์นี้ — คีย์ที่ใช้จัดอันดับ */
  eloChange: number;
  /** ตัวเลขสี่ตัวนี้นับ **เฉพาะสัปดาห์นี้** ไม่ใช่ยอดสะสม (ADR-046 ข้อ 3) */
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRate: number;
  /** เวลาที่ดีที่สุดของสัปดาห์นี้ — `null` = สัปดาห์นี้ยังไม่เคยแก้สำเร็จ */
  bestTime: number | null;
}

/** รูปแถวดิบที่ SQL คืนมา — ตัวเลขนับทั้งหมด cast เป็น `int` ใน SQL แล้วเพื่อไม่ให้เป็น BigInt */
interface WeeklyRawRow {
  user_id: number;
  username: string;
  nickname: string | null;
  elo_rating: number | null;
  elo_change: number;
  matches_played: number;
  wins: number;
  draws: number;
  best_time: Prisma.Decimal | null;
}

/** คีย์ = ประเภทคิวบ์ + สัปดาห์ + คีย์เรียง · พอข้ามสัปดาห์คีย์เปลี่ยนเอง ไม่ต้องไล่ล้าง */
const cache = new TtlCache<WeeklyLeaderboardRow[]>(WEEKLY_CACHE_TTL_MS);

/** มีไว้ให้สโมคเทสบังคับอ่านค่าใหม่ — โค้ดที่รันจริงไม่ควรเรียก */
export function clearWeeklyCache(): void {
  cache.clear();
}

/**
 * ⚠️ กับดักที่เสียเวลาหาไปครึ่งวัน (ADR-046 ข้อ 6):
 * คอลัมน์ `started_at` เป็น `TIMESTAMP` **ไม่มี timezone** (Prisma เก็บนาฬิกาแบบ UTC ลงไปตรง ๆ)
 * แต่ถ้าส่ง `Date` ของ JS เป็นพารามิเตอร์ให้ `$queryRaw` Prisma จะส่งเป็น `timestamptz`
 * → Postgres เอาค่าในคอลัมน์ไปตีความเป็นเวลา **ตาม timezone ของ session** ก่อนเทียบ
 * ซึ่งบนเครื่องที่ตั้ง `Asia/Bangkok` ทำให้ทั้งช่วงเลื่อนไป 7 ชั่วโมงแบบเงียบ ๆ
 *
 * จึงส่งเป็น "นาฬิกา UTC" ในรูปข้อความแล้ว cast เป็น `timestamp` เอง — ตรงกับที่เก็บจริงเป๊ะ
 * และให้ผลเดียวกันไม่ว่า server ตั้ง timezone อะไรไว้
 */
function utcClock(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * ผลรวมของสัปดาห์ต่อผู้ใช้หนึ่งคน — ยุบสองระบบแมตช์ด้วย `UNION ALL` แล้ว `GROUP BY` ทีเดียว
 *
 * **นับเฉพาะห้องที่ปรับคะแนน** (1v1 `COMPETITIVE` + หลายคนโหมด `AUTO`) เพราะกระดานนี้จัดอันดับ
 * ด้วย `elo_change` — ห้องที่ไม่ปรับคะแนนมี `elo_change` เป็น `NULL` ถ้าปล่อยเข้ามาด้วยจะได้
 * `matchesPlayed` ที่ไม่ตรงกับจำนวนแมตช์ที่ทำให้คะแนนขยับ (ADR-046 ข้อ 3)
 *
 * ชนะ/แพ้/เสมอ ใช้กติกาเดียวกับ `outcomeOf()` ใน `stats.service.ts` เป๊ะ ๆ (ADR-045 ข้อ 2):
 *   - 1v1: `winner_id` ชี้มาที่เรา = ชนะ · `winner_id` เป็น `NULL` = เสมอ (1v1 ไม่มีทางเป็นอย่างอื่น)
 *   - หลายคน: อันดับ 1 และแก้สำเร็จ **คนเดียว** = ชนะ · อันดับ 1 แต่ไม่ใช่คนเดียว = เสมอ
 */
export function weeklySql(
  cubeType: ApiCubeType,
  week: WeekRange,
  sortBy: 'elo' | 'bestTime',
): Prisma.Sql {
  const from = utcClock(week.start);
  const to = utcClock(week.end);

  // ค่า enum `CubeType` ใน DB ถูก @map ให้ตรงกับค่าบน API อยู่แล้ว ('3x3x3' ฯลฯ) จึงส่งตรงได้
  const orderBy =
    sortBy === 'bestTime'
      ? Prisma.sql`MIN(s.solve_time) ASC NULLS LAST, s.user_id ASC`
      : Prisma.sql`SUM(COALESCE(s.elo_change, 0)) DESC, s.user_id ASC`;

  return Prisma.sql`
    WITH week_multi AS (
      SELECT multiplayer_match_id
      FROM "MultiplayerMatch"
      WHERE cube_type = ${cubeType}::"CubeType"
        AND room_mode = 'AUTO'
        AND started_at >= ${from}::timestamp
        AND started_at < ${to}::timestamp
    ),
    multi_solve AS (
      SELECT
        p.user_id,
        p.elo_change,
        p.solve_time,
        p.rank_no,
        p.result,
        -- จำนวนคนที่ได้อันดับ 1 และแก้สำเร็จในแมตช์เดียวกัน — ใช้แยก "ชนะ" ออกจาก "เสมอ"
        SUM(CASE WHEN p.rank_no = 1 AND p.result = 'SOLVED' THEN 1 ELSE 0 END)
          OVER (PARTITION BY p.multiplayer_match_id) AS first_place_count
      FROM "MultiplayerMatchParticipant" p
      JOIN week_multi w ON w.multiplayer_match_id = p.multiplayer_match_id
    ),
    solves AS (
      SELECT
        m.player1_id        AS user_id,
        m.player1_elo_change AS elo_change,
        m.player1_time      AS solve_time,
        (m.winner_id = m.player1_id) AS won,
        (m.winner_id IS NULL)        AS drawn
      FROM "Match" m
      WHERE m.cube_type = ${cubeType}::"CubeType"
        AND m.room_type = 'COMPETITIVE'
        AND m.started_at >= ${from}::timestamp
        AND m.started_at < ${to}::timestamp

      UNION ALL

      SELECT
        m.player2_id,
        m.player2_elo_change,
        m.player2_time,
        (m.winner_id = m.player2_id),
        (m.winner_id IS NULL)
      FROM "Match" m
      WHERE m.cube_type = ${cubeType}::"CubeType"
        AND m.room_type = 'COMPETITIVE'
        AND m.started_at >= ${from}::timestamp
        AND m.started_at < ${to}::timestamp

      UNION ALL

      SELECT
        ms.user_id,
        ms.elo_change,
        ms.solve_time,
        (ms.rank_no = 1 AND ms.result = 'SOLVED' AND ms.first_place_count = 1),
        (ms.rank_no = 1 AND ms.first_place_count <> 1)
      FROM multi_solve ms
    )
    SELECT
      s.user_id,
      u.username,
      u.nickname,
      r.elo_rating,
      SUM(COALESCE(s.elo_change, 0))::int             AS elo_change,
      COUNT(*)::int                                   AS matches_played,
      COUNT(*) FILTER (WHERE s.won)::int              AS wins,
      COUNT(*) FILTER (WHERE s.drawn)::int            AS draws,
      MIN(s.solve_time)                               AS best_time
    FROM solves s
    JOIN "User" u ON u.user_id = s.user_id AND u.deleted_at IS NULL
    LEFT JOIN "Rating" r ON r.user_id = s.user_id AND r.cube_type = ${cubeType}::"CubeType"
    GROUP BY s.user_id, u.username, u.nickname, r.elo_rating
    ORDER BY ${orderBy}
    LIMIT ${WEEKLY_MAX_ROWS}
  `;
}

async function queryWeekly(
  cubeType: ApiCubeType,
  week: WeekRange,
  sortBy: 'elo' | 'bestTime',
): Promise<WeeklyLeaderboardRow[]> {
  const rows = await prisma.$queryRaw<WeeklyRawRow[]>(weeklySql(cubeType, week, sortBy));

  return rows.map((row, i) => ({
    rank: i + 1,
    userId: row.user_id,
    username: row.username,
    nickname: row.nickname,
    eloRating: row.elo_rating ?? 0,
    eloChange: row.elo_change,
    matchesPlayed: row.matches_played,
    wins: row.wins,
    // แพ้ = ที่เหลือจากชนะกับเสมอ — ไม่ต้องนับแยกอีกคอลัมน์
    losses: row.matches_played - row.wins - row.draws,
    winRate: winRateOf(row.wins, row.matches_played - row.wins - row.draws, row.draws),
    bestTime: row.best_time === null ? null : Number(row.best_time),
  }));
}

export interface WeeklyLeaderboardResult {
  rows: WeeklyLeaderboardRow[];
  week: WeekRange;
}

/**
 * อันดับรายสัปดาห์ทั้งกระดาน (ยังไม่แบ่งหน้า) — cache 60 วินาทีต่อ (ประเภท + สัปดาห์ + คีย์เรียง)
 *
 * cache ทั้งกระดานแล้วค่อยตัดหน้าใน memory ทีหลัง → เปิดหน้า 2 ไม่ต้องยิง query ใหม่
 */
export async function getWeeklyLeaderboard(
  cubeType: ApiCubeType,
  sortBy: 'elo' | 'bestTime',
  now: Date = new Date(),
): Promise<WeeklyLeaderboardResult> {
  const week = weekRangeOf(now);
  const key = `${cubeType}:${weekKeyOf(week)}:${sortBy}`;

  return {
    rows: await cache.getOrCompute(key, () => queryWeekly(cubeType, week, sortBy)),
    week,
  };
}
