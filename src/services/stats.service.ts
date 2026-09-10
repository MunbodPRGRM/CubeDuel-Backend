/**
 * สถิติรายคน + ประวัติการแข่ง — `docs/api-contract.md` ข้อ 3 (`/users/:userId/matches`) และ ข้อ 4
 *
 * สองหน้าจอนี้กินข้อมูลชุดเดียวกัน: **solve ทุกครั้งของผู้ใช้คนหนึ่ง เรียงจากใหม่ไปเก่า**
 * ซึ่งกระจายอยู่สองตาราง (`Match` สำหรับ 1v1 · `MultiplayerMatchParticipant` สำหรับ 3–4 คน)
 * จึงมี `readSolveHistory()` เป็นทางอ่านทางเดียว แล้วทั้ง `/stats` และ `/matches` ต่อยอดจากมัน
 * (ADR-045 ข้อ 1 — ทำไมถึงรวมใน memory แทนที่จะเป็น SQL `UNION ALL`)
 *
 * ห้องฝึกซ้อมไม่มีแถวใน DB เลย จึงไม่มีทางหลุดเข้ามาในสถิติอยู่แล้ว (api-contract.md ข้อ 4)
 */
import { RoomMode, RoomType, SolveResult, type CubeType as PrismaCubeType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { assignRanks } from '../lib/ranking.js';
import {
  averageOfN,
  bestTime,
  meanTime,
  winRateOf,
  winStreaks,
  worstTime,
  type MatchOutcomeForUser,
} from '../lib/stats.js';
import { CUBE_TYPE_TO_PRISMA, PRISMA_TO_CUBE_TYPE, type ApiCubeType } from '../types/cube.js';
import type { SolveStatus } from '../sockets/types.js';

const STATUS_OF: Record<SolveResult, SolveStatus> = {
  [SolveResult.SOLVED]: 'solved',
  [SolveResult.DNF]: 'dnf',
  [SolveResult.SURRENDERED]: 'surrendered',
};

/** ผู้เล่นคนหนึ่งในรูปที่ส่งออกทาง API — ชุดเดียวกับที่ `match.service.ts` คืน */
interface HistoryUser {
  userId: number;
  username: string;
  nickname: string | null;
}

/**
 * solve หนึ่งครั้งของผู้ใช้คนหนึ่ง — รูปกลางที่รวมสองระบบแมตช์ไว้ด้วยกัน
 * ทั้ง `/stats` และ `/matches` อ่านจากรูปนี้ ไม่แตะ Prisma เอง
 */
export interface SolveHistoryEntry {
  kind: '1v1' | 'multiplayer';
  /** ตั้งค่าเฉพาะ `kind === '1v1'` — เลข id ของสองตารางชนกันได้ (ADR-044 ข้อ 1) */
  matchId: number | null;
  /** ตั้งค่าเฉพาะ `kind === 'multiplayer'` */
  multiplayerMatchId: number | null;
  cubeType: ApiCubeType;
  /** ห้องนี้ปรับ Elo ไหม — 1v1 คือ `COMPETITIVE` · หลายคนคือโหมด `AUTO` */
  rated: boolean;
  roomType: 'competitive' | 'custom' | null;
  roomMode: 'auto' | 'custom' | null;
  scramble: string;
  /** วินาที — `null` = DNF/ยอมแพ้ (ดู `status` ควบคู่) */
  solveTime: number | null;
  status: SolveStatus;
  /** ผลของแมตช์เมื่อมองจากผู้ใช้คนนี้ — กติกาเดียวกับที่ `Rating` นับ (ADR-041 ข้อ 1) */
  outcome: MatchOutcomeForUser;
  rankNo: number;
  playerCount: number;
  /** มีเฉพาะ 1v1 — ห้องหลายคนไม่มี "คู่ต่อสู้" คนเดียวให้ชี้ */
  opponent: HistoryUser | null;
  opponentTime: number | null;
  /** `null` = ห้องที่ไม่ปรับคะแนน */
  eloChange: number | null;
  startedAt: Date;
}

export interface SolveHistoryFilter {
  cubeType?: ApiCubeType;
}

/** ต้องเช็คทุก endpoint ที่มี `:userId` ว่าผู้ใช้มีอยู่จริงและไม่ถูกลบ (api-contract.md ข้อ 11) */
async function requireUser(userId: number): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { userId, deletedAt: null },
    select: { userId: true },
  });
  if (!user) throw errors.notFound('ไม่พบผู้ใช้รายนี้');
}

/**
 * ชนะ/แพ้/เสมอ จากมุมของผู้ใช้คนหนึ่ง — กติกาเดียวกับ `applyPlayerResult()` ตอนบันทึกผล
 * (ADR-041 ข้อ 1): เป็นผู้ชนะ = ชนะ · ไม่มีผู้ชนะ **และ** เราอยู่ในกลุ่มอันดับ 1 = เสมอ · นอกนั้นแพ้
 */
function outcomeOf(userId: number, winnerId: number | null, rankNo: number): MatchOutcomeForUser {
  if (winnerId === userId) return 'win';
  if (winnerId === null && rankNo === 1) return 'draw';
  return 'loss';
}

/** แถวจากตาราง `Match` → รูปกลาง (ต้องคำนวณ `rankNo` ใหม่ เพราะ 1v1 ไม่ได้เก็บไว้ใน DB) */
async function read1v1History(
  userId: number,
  cubeType: PrismaCubeType | undefined,
): Promise<SolveHistoryEntry[]> {
  const rows = await prisma.match.findMany({
    where: {
      ...(cubeType ? { cubeType } : {}),
      OR: [{ player1Id: userId }, { player2Id: userId }],
    },
    orderBy: { startedAt: 'desc' },
    include: {
      player1: { select: { userId: true, username: true, nickname: true } },
      player2: { select: { userId: true, username: true, nickname: true } },
    },
  });

  return rows.map((row) => {
    const selfIsPlayer1 = row.player1Id === userId;
    const self = {
      time: selfIsPlayer1 ? row.player1Time : row.player2Time,
      result: selfIsPlayer1 ? row.player1Result : row.player2Result,
      eloChange: selfIsPlayer1 ? row.player1EloChange : row.player2EloChange,
    };
    const other = {
      user: selfIsPlayer1 ? row.player2 : row.player1,
      time: selfIsPlayer1 ? row.player2Time : row.player1Time,
      result: selfIsPlayer1 ? row.player2Result : row.player1Result,
    };

    // `rank_no` ของ 1v1 ไม่มีคอลัมน์ใน DB — คำนวณใหม่จากเวลาด้วยตัวเดียวกับตอนจบแมตช์จริง
    const ranks = assignRanks([
      {
        userId,
        status: STATUS_OF[self.result],
        solveTimeMs: self.time === null ? null : Math.round(self.time.toNumber() * 1000),
      },
      {
        userId: other.user.userId,
        status: STATUS_OF[other.result],
        solveTimeMs: other.time === null ? null : Math.round(other.time.toNumber() * 1000),
      },
    ]);
    const rankNo = ranks.get(userId) ?? 1;
    const competitive = row.roomType === RoomType.COMPETITIVE;

    return {
      kind: '1v1' as const,
      matchId: row.matchId,
      multiplayerMatchId: null,
      cubeType: PRISMA_TO_CUBE_TYPE[row.cubeType],
      rated: competitive,
      roomType: competitive ? ('competitive' as const) : ('custom' as const),
      roomMode: null,
      scramble: row.scramble,
      solveTime: self.time === null ? null : self.time.toNumber(),
      status: STATUS_OF[self.result],
      outcome: outcomeOf(userId, row.winnerId, rankNo),
      rankNo,
      playerCount: 2,
      opponent: other.user,
      opponentTime: other.time === null ? null : other.time.toNumber(),
      eloChange: self.eloChange,
      startedAt: row.startedAt,
    };
  });
}

/**
 * แถวจากตาราง `MultiplayerMatchParticipant` → รูปกลาง
 *
 * `rank_no` เก็บใน DB จริงจึงใช้ค่านั้นตรง ๆ · แต่ `winner_id` ไม่มีคอลัมน์ ต้องอ่านจากผู้เข้าร่วม
 * ที่ได้อันดับ 1 **คนเดียว** และแก้เสร็จจริง (กติกาเดียวกับ `findWinnerId()`) จึงต้องดึงอันดับของ
 * เพื่อนร่วมห้องมาด้วย — แถวละ 3–4 คน ไม่หนัก
 */
async function readMultiplayerHistory(
  userId: number,
  cubeType: PrismaCubeType | undefined,
): Promise<SolveHistoryEntry[]> {
  const rows = await prisma.multiplayerMatchParticipant.findMany({
    where: { userId, ...(cubeType ? { match: { cubeType } } : {}) },
    include: {
      match: {
        include: { participants: { select: { userId: true, rankNo: true, result: true } } },
      },
    },
  });

  return rows.map((row) => {
    const firstPlace = row.match.participants.filter(
      (p) => p.rankNo === 1 && p.result === SolveResult.SOLVED,
    );
    const winnerId = firstPlace.length === 1 ? firstPlace[0]!.userId : null;
    const auto = row.match.roomMode === RoomMode.AUTO;

    return {
      kind: 'multiplayer' as const,
      matchId: null,
      multiplayerMatchId: row.multiplayerMatchId,
      cubeType: PRISMA_TO_CUBE_TYPE[row.match.cubeType],
      rated: auto,
      roomType: null,
      roomMode: auto ? ('auto' as const) : ('custom' as const),
      scramble: row.match.scramble,
      solveTime: row.solveTime === null ? null : row.solveTime.toNumber(),
      status: STATUS_OF[row.result],
      outcome: outcomeOf(userId, winnerId, row.rankNo),
      rankNo: row.rankNo,
      playerCount: row.match.playerCount,
      opponent: null,
      opponentTime: null,
      eloChange: row.eloChange,
      startedAt: row.match.startedAt,
    };
  });
}

/**
 * ประวัติ solve ทั้งหมดของผู้ใช้คนหนึ่ง เรียงจากใหม่ไปเก่า — **ทางอ่านทางเดียวของไฟล์นี้**
 *
 * เวลาเท่ากันเป๊ะ (เช่นข้อมูล seed) ตัดสินด้วยเลข id เพื่อให้ลำดับคงที่ระหว่างการแบ่งหน้า
 */
export async function readSolveHistory(
  userId: number,
  filter: SolveHistoryFilter = {},
): Promise<SolveHistoryEntry[]> {
  const cubeType = filter.cubeType ? CUBE_TYPE_TO_PRISMA[filter.cubeType] : undefined;

  const [singles, multis] = await Promise.all([
    read1v1History(userId, cubeType),
    readMultiplayerHistory(userId, cubeType),
  ]);

  return [...singles, ...multis].sort((a, b) => {
    const byTime = b.startedAt.getTime() - a.startedAt.getTime();
    if (byTime !== 0) return byTime;
    return (b.matchId ?? b.multiplayerMatchId ?? 0) - (a.matchId ?? a.multiplayerMatchId ?? 0);
  });
}

// ---------------------------------------------------------------- GET /users/:userId/stats

export interface UserStats {
  cubeType: ApiCubeType;
  /** จำนวน solve ที่นับได้จริงจากตารางแมตช์ */
  totalSolves: number;
  /** `matches_played` ในตาราง `Rating` — ต้องเท่ากับ `totalSolves` เสมอ (ADR-045 ข้อ 3) */
  totalMatches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  dnfCount: number;
  best: number | null;
  worst: number | null;
  mean: number | null;
  ao5: number | null;
  ao12: number | null;
  ao100: number | null;
  currentStreak: number;
  bestStreak: number;
}

/**
 * สถิติของผู้ใช้คนหนึ่งในประเภทรูบิคหนึ่ง (api-contract.md ข้อ 4)
 *
 * ตัวเลขที่ตาราง `Rating` ดูแลอยู่แล้ว (`totalMatches` / `wins` / `losses` / `draws`) อ่านจากที่นั่น
 * เพื่อให้ตรงกับ `GET /users/:userId/ratings` และกระดานอันดับเป๊ะ ส่วนที่เหลือคำนวณสดจากประวัติ
 * (ADR-045 ข้อ 3)
 */
export async function getUserStats(userId: number, cubeType: ApiCubeType): Promise<UserStats> {
  await requireUser(userId);

  const [rating, history] = await Promise.all([
    prisma.rating.findUnique({
      where: { userId_cubeType: { userId, cubeType: CUBE_TYPE_TO_PRISMA[cubeType] } },
      select: { matchesPlayed: true, wins: true, losses: true, draws: true },
    }),
    readSolveHistory(userId, { cubeType }),
  ]);

  const times = history.map((entry) => entry.solveTime);
  const streaks = winStreaks(history.map((entry) => entry.outcome));

  return {
    cubeType,
    totalSolves: history.length,
    totalMatches: rating?.matchesPlayed ?? 0,
    wins: rating?.wins ?? 0,
    losses: rating?.losses ?? 0,
    draws: rating?.draws ?? 0,
    winRate: winRateOf(rating?.wins ?? 0, rating?.losses ?? 0, rating?.draws ?? 0),
    dnfCount: times.filter((time) => time === null).length,
    best: bestTime(times),
    worst: worstTime(times),
    mean: meanTime(times),
    ao5: averageOfN(times, 5),
    ao12: averageOfN(times, 12),
    ao100: averageOfN(times, 100),
    currentStreak: streaks.current,
    bestStreak: streaks.best,
  };
}

// ---------------------------------------------------------------- GET /users/:userId/matches

/** แถวประวัติของแมตช์ 1v1 (api-contract.md ข้อ 3) */
export interface MatchHistory1v1Row {
  kind: '1v1';
  matchId: number;
  roomType: 'competitive' | 'custom';
  cubeType: ApiCubeType;
  scramble: string;
  /** วินาที — `null` = DNF/ยอมแพ้ */
  myTime: number | null;
  opponent: HistoryUser;
  opponentTime: number | null;
  result: MatchOutcomeForUser;
  eloChange: number | null;
  startedAt: string;
}

/** แถวประวัติของแมตช์ผู้เล่นหลายคน — ไม่มี `opponent` เพราะมีคู่แข่งหลายคน */
export interface MatchHistoryMultiRow {
  kind: 'multiplayer';
  multiplayerMatchId: number;
  roomMode: 'auto' | 'custom';
  cubeType: ApiCubeType;
  scramble: string;
  myTime: number | null;
  rankNo: number;
  playerCount: number;
  result: MatchOutcomeForUser;
  eloChange: number | null;
  startedAt: string;
}

export type MatchHistoryRow = MatchHistory1v1Row | MatchHistoryMultiRow;

export interface MatchHistoryQuery {
  cubeType?: ApiCubeType;
  /** กรองตาม "ห้องที่ปรับคะแนน" — `competitive` = 1v1 แข่งขัน + หลายคนโหมด auto (ADR-045 ข้อ 4) */
  roomType?: 'competitive' | 'custom';
  kind?: '1v1' | 'multiplayer';
  page: number;
  limit: number;
}

function toHistoryRow(entry: SolveHistoryEntry): MatchHistoryRow {
  const shared = {
    cubeType: entry.cubeType,
    scramble: entry.scramble,
    myTime: entry.solveTime,
    result: entry.outcome,
    eloChange: entry.eloChange,
    startedAt: entry.startedAt.toISOString(),
  };

  if (entry.kind === '1v1') {
    return {
      kind: '1v1',
      matchId: entry.matchId!,
      roomType: entry.roomType!,
      opponent: entry.opponent!,
      opponentTime: entry.opponentTime,
      ...shared,
    };
  }

  return {
    kind: 'multiplayer',
    multiplayerMatchId: entry.multiplayerMatchId!,
    roomMode: entry.roomMode!,
    rankNo: entry.rankNo,
    playerCount: entry.playerCount,
    ...shared,
  };
}

/**
 * ประวัติการแข่งรวมสองระบบแมตช์ + แบ่งหน้า (api-contract.md ข้อ 3)
 *
 * กรอง/แบ่งหน้าใน memory เพราะสองตารางเรียงร่วมกันด้วย SQL ไม่ได้ถ้าไม่เขียน raw `UNION ALL`
 * — เหตุผลและเงื่อนไขที่ต้องเปลี่ยนอยู่ใน ADR-045 ข้อ 1
 */
export async function getUserMatchHistory(userId: number, q: MatchHistoryQuery) {
  await requireUser(userId);

  const history = await readSolveHistory(userId, { cubeType: q.cubeType });

  const filtered = history.filter((entry) => {
    if (q.kind && entry.kind !== q.kind) return false;
    if (q.roomType === 'competitive' && !entry.rated) return false;
    if (q.roomType === 'custom' && entry.rated) return false;
    return true;
  });

  const start = (q.page - 1) * q.limit;
  const data = filtered.slice(start, start + q.limit).map(toHistoryRow);

  return {
    data,
    meta: {
      page: q.page,
      limit: q.limit,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / q.limit)),
    },
  };
}
