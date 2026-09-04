import type { CubeType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { ALL_CUBE_TYPES } from '../constants.js';
import { PRISMA_TO_CUBE_TYPE, type ApiCubeType } from '../types/cube.js';

/**
 * กระดานอันดับ + คะแนนรายบุคคล — ที่มา: docs/api-contract.md ข้อ 3 และ ข้อ 5
 *
 * ⚠️ ทำมาก่อนกำหนด (เป็นงานเฟส 7) เพราะหน้าจอตามดีไซน์ต้องใช้ข้อมูลจริง
 *     `scope=weekly` ยังไม่ทำ — ต้องคำนวณจาก Match/MultiplayerMatchParticipant ซึ่งยังไม่มีข้อมูลจนถึงเฟส 5
 */

/** ตัวเลขสรุปใน Rating เป็นข้อมูลซ้ำซ้อน (ADR-014) — อ่านตรงจากตารางนี้ได้เลย ไม่ต้องนับใหม่ */
export interface LeaderboardRow {
  rank: number;
  userId: number;
  username: string;
  nickname: string | null;
  eloRating: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRate: number;
  bestTime: number | null;
}

export interface LeaderboardQuery {
  cubeType: ApiCubeType;
  scope: 'all' | 'weekly';
  sortBy: 'elo' | 'bestTime';
  page: number;
  limit: number;
}

function winRateOf(wins: number, losses: number, draws: number): number {
  const played = wins + losses + draws;
  if (played === 0) return 0;
  return Number((wins / played).toFixed(4));
}

export async function getLeaderboard(q: LeaderboardQuery) {
  if (q.scope === 'weekly') {
    throw errors.validation(
      'กระดานอันดับรายสัปดาห์ยังไม่เปิดใช้งาน (ต้องมีข้อมูลการแข่งขันก่อน — เฟส 7)',
      { scope: 'รองรับเฉพาะ all ในตอนนี้' },
    );
  }

  const cubeType = ALL_CUBE_TYPES.find((c) => PRISMA_TO_CUBE_TYPE[c] === q.cubeType) as CubeType;

  // ผู้ใช้ที่ลบบัญชีตัวเองแล้วต้องไม่โผล่บนกระดาน (ADR-008)
  const where = { cubeType, user: { deletedAt: null } };

  const orderBy =
    q.sortBy === 'bestTime'
      ? ([{ bestTime: { sort: 'asc', nulls: 'last' } }, { userId: 'asc' }] as const)
      : ([{ eloRating: 'desc' }, { userId: 'asc' }] as const);

  const [total, rows] = await Promise.all([
    prisma.rating.count({ where }),
    prisma.rating.findMany({
      where,
      orderBy: [...orderBy],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { user: { select: { userId: true, username: true, nickname: true } } },
    }),
  ]);

  const data: LeaderboardRow[] = rows.map((r, i) => ({
    // อันดับนับจากตำแหน่งในผลลัพธ์ — คะแนนเท่ากันจะได้อันดับไล่กันไป ไม่ใช่อันดับร่วม
    rank: (q.page - 1) * q.limit + i + 1,
    userId: r.user.userId,
    username: r.user.username,
    nickname: r.user.nickname,
    eloRating: r.eloRating,
    matchesPlayed: r.matchesPlayed,
    wins: r.wins,
    losses: r.losses,
    winRate: winRateOf(r.wins, r.losses, r.draws),
    bestTime: r.bestTime === null ? null : Number(r.bestTime),
  }));

  return {
    data,
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.limit)),
      scope: q.scope,
      cubeType: q.cubeType,
    },
  };
}

export interface UserRatingRow {
  cubeType: ApiCubeType;
  eloRating: number;
  rank: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  bestTime: number | null;
  updatedAt: string;
}

/** คะแนนครบทั้ง 4 ประเภทของผู้ใช้คนหนึ่ง — เรียงตามลำดับใน ALL_CUBE_TYPES เสมอ */
export async function getUserRatings(userId: number): Promise<UserRatingRow[]> {
  const user = await prisma.user.findFirst({ where: { userId, deletedAt: null } });
  if (!user) throw errors.notFound('ไม่พบผู้ใช้รายนี้');

  const ratings = await prisma.rating.findMany({ where: { userId } });

  return Promise.all(
    ALL_CUBE_TYPES.map(async (cubeType) => {
      const r = ratings.find((x) => x.cubeType === cubeType);
      const eloRating = r?.eloRating ?? 0;

      // อันดับ = จำนวนคนที่คะแนนมากกว่า + 1 (คะแนนเท่ากันได้อันดับร่วมกัน)
      const ahead = await prisma.rating.count({
        where: { cubeType, eloRating: { gt: eloRating }, user: { deletedAt: null } },
      });

      return {
        cubeType: PRISMA_TO_CUBE_TYPE[cubeType],
        eloRating,
        rank: ahead + 1,
        matchesPlayed: r?.matchesPlayed ?? 0,
        wins: r?.wins ?? 0,
        losses: r?.losses ?? 0,
        draws: r?.draws ?? 0,
        winRate: winRateOf(r?.wins ?? 0, r?.losses ?? 0, r?.draws ?? 0),
        bestTime: r?.bestTime == null ? null : Number(r.bestTime),
        updatedAt: (r?.updatedAt ?? new Date()).toISOString(),
      };
    }),
  );
}
