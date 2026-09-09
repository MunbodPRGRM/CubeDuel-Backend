/**
 * บันทึกผลแมตช์ลง DB — **เขียนครั้งเดียวตอนจบ ในทรานแซกชันเดียว** (ADR-035 ข้อ 5)
 *
 * มีสองทางเขียนตามจำนวนผู้เล่น แต่ใช้ตรรกะการนับผลชุดเดียวกัน (ADR-041 ข้อ 1):
 *   - 2 คน → `saveMatch()` ลงตาราง `Match`
 *   - 3–4 คน → `saveMultiplayerMatch()` ลงตาราง `MultiplayerMatch` + participant
 *
 * ในทรานแซกชันเดียวกันมี: แถวของแมตช์ · การอัปเดตตัวเลขสรุปใน `Rating` ของทุกคน
 * (ADR-014 บังคับไว้) · แถว `MatchFlag` ของ solve ที่เข้าเกณฑ์ soft (game-rules.md ข้อ 10)
 *
 * ไฟล์นี้ไม่รู้จัก Socket.IO เลย — ชั้น socket เป็นคนแปลงห้องเป็น `MatchOutcome` ให้
 */
import {
  Prisma,
  RoomMode,
  RoomType,
  SolveResult,
  type CubeType as PrismaCubeType,
  type FlagReason,
} from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  checkWinStreak,
  inspectSolve,
  WIN_STREAK_LOOKBACK,
  type RatedMatchRow,
  type SolveSample,
} from '../lib/anti-cheat.js';
import { errors } from '../lib/errors.js';
import { assignRanks, toDbSeconds } from '../lib/ranking.js';
import { CUBE_TYPE_TO_PRISMA, PRISMA_TO_CUBE_TYPE, type ApiCubeType } from '../types/cube.js';
import type { SolveStatus } from '../sockets/types.js';

export interface MatchPlayerOutcome {
  userId: number;
  username: string;
  /** 1 = `player1_id` ของแถว `Match` — ลำดับนี้ต้องคงที่ (database-schema.md) */
  seatNo: number;
  status: SolveStatus;
  /** null = DNF/ยอมแพ้ */
  solveTimeMs: number | null;
  moveCount: number;
  /** เวลาที่ server ได้รับแต่ละ move นับจาก serverStartTs — ใช้ตรวจเกณฑ์ soft */
  moveTimestampsMs: readonly number[];
  /** move stream เต็ม — คัดลง `MatchFlag.move_log` เฉพาะ solve ที่ถูก flag */
  moveLog: readonly { seq: number; move: string; ms: number }[];
  eloBefore: number;
  /** null = ห้องที่ไม่ปรับคะแนน (ห้องสร้างเอง) */
  eloChange: number | null;
  rankNo: number;
}

export interface MatchOutcome {
  roomType: RoomType;
  cubeType: ApiCubeType;
  scramble: string;
  roomCode: string | null;
  spectatorCount: number;
  startedAtTs: number;
  finishedAtTs: number;
  /** null = เสมอ (เวลาเท่ากัน หรือ DNF ทั้งคู่ ตาม ADR-007) */
  winnerId: number | null;
  players: MatchPlayerOutcome[];
}

/**
 * ผลของห้องผู้เล่นหลายคน (3–4 คน) — `MultiplayerMatch` ไม่มีคอลัมน์ `winner_id`
 * ผู้ชนะอ่านย้อนหลังได้จาก participant ที่ `rank_no = 1` คนเดียวและ `result = SOLVED`
 * แต่ตอนบันทึกยังต้องรู้ เพราะ `wins`/`draws`/`losses` ใน `Rating` นับด้วยกติกาเดียวกับ 1v1
 * (ADR-041 ข้อ 1)
 */
export interface MultiplayerMatchOutcome {
  roomMode: RoomMode;
  cubeType: ApiCubeType;
  scramble: string;
  /** มีเฉพาะโหมด custom (ห้องที่เข้าด้วยรหัส) — โหมด auto เป็น null เสมอ */
  roomCode: string | null;
  startedAtTs: number;
  finishedAtTs: number;
  /** null = ไม่มีใครได้อันดับ 1 คนเดียว (เวลาเท่ากัน หรือ DNF ทั้งห้อง) */
  winnerId: number | null;
  players: MatchPlayerOutcome[];
}

const RESULT_OF: Record<SolveStatus, SolveResult> = {
  solved: SolveResult.SOLVED,
  surrendered: SolveResult.SURRENDERED,
  dnf: SolveResult.DNF,
  // ยังแก้อยู่ตอนแมตช์จบ = แก้ไม่ทัน
  solving: SolveResult.DNF,
};

function sideData(player: MatchPlayerOutcome) {
  const solved = player.status === 'solved' && player.solveTimeMs !== null;
  return {
    result: RESULT_OF[player.status],
    // NULL ในคอลัมน์เวลา = DNF/DNS เสมอ ห้ามใช้ 0 แทน (database-schema.md)
    time: solved ? new Prisma.Decimal(toDbSeconds(player.solveTimeMs!)) : null,
    moveCount: player.moveCount,
  };
}

/**
 * แมตช์ที่ flag ชี้ไป — ตั้งได้ช่องเดียวเท่านั้น (CHECK `MatchFlag_exactly_one_match_ref`
 * ใน migration บังคับไว้อีกชั้น) · แมตช์หลายคนใช้คอลัมน์ `multiplayer_match_id` — ADR-041 ข้อ 2
 */
type MatchFlagRef = { matchId: number } | { multiplayerMatchId: number };

/** ตัวเขียน `MatchFlag` ตัวเดียวของไฟล์นี้ — ทุก flag ต้องผ่านทางนี้ (จะได้เก็บ move_log เหมือนกัน) */
async function writeFlag(
  tx: Prisma.TransactionClient,
  ref: MatchFlagRef,
  player: MatchPlayerOutcome,
  flag: { reason: FlagReason; detail: Record<string, unknown> },
): Promise<void> {
  await tx.matchFlag.create({
    data: {
      ...ref,
      userId: player.userId,
      flagReason: flag.reason,
      detail: flag.detail as Prisma.InputJsonValue,
      // เก็บ move stream เฉพาะแมตช์ที่ถูก flag เท่านั้น (job ล้างเป็น NULL หลัง 90 วัน)
      moveLog: player.moveLog as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * ตรวจเกณฑ์ "ชนะรวดผิดปกติ" ของผู้ชนะ — **ต้องอยู่ในทรานแซกชันเดียวกับที่เพิ่งเขียน `Match`**
 * เพราะแมตช์ที่เพิ่งจบต้องนับเป็นแมตช์แรกของสตรีคด้วย
 *
 * ดูเฉพาะห้องแข่งขันของ `cube_type` เดียวกัน — Elo แยกตามประเภท สตรีคจึงต้องแยกตามประเภทด้วย
 */
async function flagWinStreak(
  tx: Prisma.TransactionClient,
  matchId: number,
  outcome: MatchOutcome,
  cubeType: PrismaCubeType,
): Promise<void> {
  const winnerId = outcome.winnerId;
  if (outcome.roomType !== RoomType.COMPETITIVE || winnerId === null) return;
  const winner = outcome.players.find((player) => player.userId === winnerId);
  if (!winner) return;

  const recent = await tx.match.findMany({
    where: {
      roomType: RoomType.COMPETITIVE,
      cubeType,
      OR: [{ player1Id: winnerId }, { player2Id: winnerId }],
    },
    orderBy: { matchId: 'desc' },
    take: WIN_STREAK_LOOKBACK,
    select: {
      matchId: true,
      winnerId: true,
      player1Id: true,
      player1EloBefore: true,
      player2EloBefore: true,
    },
  });

  const rows: RatedMatchRow[] = recent.map((row) => {
    const selfIsPlayer1 = row.player1Id === winnerId;
    return {
      matchId: row.matchId,
      winnerId: row.winnerId,
      selfEloBefore: selfIsPlayer1 ? row.player1EloBefore : row.player2EloBefore,
      opponentEloBefore: selfIsPlayer1 ? row.player2EloBefore : row.player1EloBefore,
    };
  });

  const flag = checkWinStreak(winnerId, rows, outcome.cubeType);
  if (flag) await writeFlag(tx, { matchId }, winner, flag);
}

// ---------------------------------------------------------------- ส่วนที่สองระบบใช้ร่วมกัน

/**
 * งานที่ต้องทำต่อผู้เล่นหนึ่งคน ไม่ว่าจะเป็นแมตช์ 1v1 หรือหลายคน — **ต้องอยู่ในทรานแซกชัน
 * เดียวกับที่เพิ่งเขียนแถวของแมตช์** (ADR-014):
 *   1. อัปเดต `Rating` — Elo + ตัวเลขสรุป (`matches_played` / `wins` / `losses` / `draws` / `best_time`)
 *   2. เขียน `MatchFlag` ของ solve ที่เข้าเกณฑ์ soft
 *
 * กติกานับ win/draw/loss เหมือนกันทั้งสองระบบ (ADR-041 ข้อ 1):
 * `winner_id` เป็นเรา = ชนะ · `winner_id` เป็น NULL และ `rank_no = 1` = เสมอ · นอกนั้นแพ้
 */
async function applyPlayerResult(
  tx: Prisma.TransactionClient,
  ref: MatchFlagRef,
  context: { cubeType: PrismaCubeType; apiCubeType: ApiCubeType; winnerId: number | null },
  player: MatchPlayerOutcome,
): Promise<void> {
  const { cubeType, winnerId } = context;
  const key = { userId_cubeType: { userId: player.userId, cubeType } };

  const current = await tx.rating.findUnique({ where: key, select: { bestTime: true } });
  const time = sideData(player).time;
  // best_time นับเฉพาะ solve ที่สำเร็จ และนับห้องสร้างเองด้วย (ADR-035 ข้อ 4)
  const improved =
    time !== null && (current?.bestTime == null || time.lessThan(current.bestTime));

  const won = winnerId === player.userId;
  // เสมอ = ไม่มีใครได้อันดับ 1 คนเดียว **และ** ตัวเราอยู่ในกลุ่มอันดับ 1 นั้น
  const drew = winnerId === null && player.rankNo === 1;

  await tx.rating.update({
    where: key,
    data: {
      matchesPlayed: { increment: 1 },
      wins: { increment: won ? 1 : 0 },
      losses: { increment: !won && !drew ? 1 : 0 },
      draws: { increment: drew ? 1 : 0 },
      ...(improved ? { bestTime: time } : {}),
      ...(player.eloChange === null ? {} : { eloRating: { increment: player.eloChange } }),
    },
  });

  if (player.status !== 'solved' || player.solveTimeMs === null) return;

  const sample: SolveSample = {
    cubeType: context.apiCubeType,
    solveTimeMs: player.solveTimeMs,
    moveCount: player.moveCount,
    moveTimestampsMs: player.moveTimestampsMs,
  };
  for (const flag of inspectSolve(sample)) {
    await writeFlag(tx, ref, player, flag);
  }
}

/**
 * เขียนผลลงตาราง `Match` + `Rating` + `MatchFlag`
 * คืน `match_id` ที่เพิ่งสร้าง — ใช้ส่งกลับใน `match:finished`
 */
export async function saveMatch(outcome: MatchOutcome): Promise<number> {
  const [player1, player2] = [...outcome.players].sort((a, b) => a.seatNo - b.seatNo);
  if (!player1 || !player2) throw new Error('แมตช์ 1v1 ต้องมีผู้เล่นครบ 2 คนก่อนบันทึก');

  const cubeType = CUBE_TYPE_TO_PRISMA[outcome.cubeType];
  const side1 = sideData(player1);
  const side2 = sideData(player2);

  return prisma.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        roomType: outcome.roomType,
        cubeType,
        player1Id: player1.userId,
        player2Id: player2.userId,
        scramble: outcome.scramble,
        roomCode: outcome.roomCode,
        player1Time: side1.time,
        player2Time: side2.time,
        player1Result: side1.result,
        player2Result: side2.result,
        player1MoveCount: side1.moveCount,
        player2MoveCount: side2.moveCount,
        // ห้องที่ไม่ปรับคะแนนเก็บ NULL ทั้ง 4 ช่อง (database-schema.md)
        player1EloBefore: player1.eloChange === null ? null : player1.eloBefore,
        player1EloChange: player1.eloChange,
        player2EloBefore: player2.eloChange === null ? null : player2.eloBefore,
        player2EloChange: player2.eloChange,
        winnerId: outcome.winnerId,
        spectatorCount: outcome.spectatorCount,
        startedAt: new Date(outcome.startedAtTs),
        finishedAt: new Date(outcome.finishedAtTs),
      },
      select: { matchId: true },
    });

    const context = {
      cubeType,
      apiCubeType: outcome.cubeType,
      winnerId: outcome.winnerId,
    };
    for (const player of [player1, player2]) {
      await applyPlayerResult(tx, { matchId: match.matchId }, context, player);
    }

    await flagWinStreak(tx, match.matchId, outcome, cubeType);

    return match.matchId;
  });
}

/**
 * เขียนผลห้องผู้เล่นหลายคน (3–4 คน) ลง `MultiplayerMatch` + `MultiplayerMatchParticipant`
 * + `Rating` + `MatchFlag` — คืน `multiplayer_match_id` ที่เพิ่งสร้าง
 *
 * ต่างจาก `saveMatch()` แค่รูปตารางที่เขียน: การนับผลและการ flag ใช้ `applyPlayerResult()`
 * ตัวเดียวกัน · **ไม่ตรวจเกณฑ์ `WIN_STREAK`** เพราะนิยามอิงคู่ต่อสู้คนเดียว ห้องหลายคน
 * ไม่มีสิ่งนั้นให้เทียบ (ADR-041 ข้อ 2)
 */
export async function saveMultiplayerMatch(outcome: MultiplayerMatchOutcome): Promise<number> {
  const players = [...outcome.players].sort((a, b) => a.seatNo - b.seatNo);
  if (players.length < 3 || players.length > 4) {
    throw new Error(`แมตช์หลายคนต้องมีผู้เล่น 3 หรือ 4 คน (ได้ ${players.length})`);
  }

  const cubeType = CUBE_TYPE_TO_PRISMA[outcome.cubeType];

  return prisma.$transaction(async (tx) => {
    const match = await tx.multiplayerMatch.create({
      data: {
        cubeType,
        roomMode: outcome.roomMode,
        scramble: outcome.scramble,
        // คอลัมน์นี้มีความหมายเฉพาะโหมด custom — ห้องจับคู่อัตโนมัติไม่มีรหัสห้อง
        roomCode: outcome.roomMode === RoomMode.CUSTOM ? outcome.roomCode : null,
        playerCount: players.length,
        startedAt: new Date(outcome.startedAtTs),
        finishedAt: new Date(outcome.finishedAtTs),
      },
      select: { multiplayerMatchId: true },
    });

    await tx.multiplayerMatchParticipant.createMany({
      data: players.map((player) => {
        const side = sideData(player);
        return {
          multiplayerMatchId: match.multiplayerMatchId,
          userId: player.userId,
          solveTime: side.time,
          result: side.result,
          rankNo: player.rankNo,
          moveCount: side.moveCount,
          // โหมด custom ไม่ปรับคะแนน → เก็บ NULL ทั้งสองช่อง (database-schema.md ตารางที่ 8)
          eloBefore: player.eloChange === null ? null : player.eloBefore,
          eloChange: player.eloChange,
        };
      }),
    });

    const context = {
      cubeType,
      apiCubeType: outcome.cubeType,
      winnerId: outcome.winnerId,
    };
    for (const player of players) {
      await applyPlayerResult(
        tx,
        { multiplayerMatchId: match.multiplayerMatchId },
        context,
        player,
      );
    }

    return match.multiplayerMatchId;
  });
}

// ---------------------------------------------------------------- อ่านผลย้อนหลัง

/** รูปเดียวกับ `MatchResultEntry` ของ `match:finished` — หน้าจอเดียวกันใช้ได้ทั้งสองทาง */
export interface MatchDetailPlayer {
  userId: number;
  username: string;
  nickname: string | null;
  /** 1 = `player1_id` — ลำดับที่เข้าคิว/สร้างห้อง (database-schema.md) */
  seatNo: 1 | 2;
  rankNo: number;
  /** วินาที — null = DNF/ยอมแพ้ (ดู `result` ควบคู่) */
  solveTime: number | null;
  result: SolveStatus;
  moveCount: number;
  /** null ทั้งสามช่องในห้องที่ไม่ปรับคะแนน */
  eloBefore: number | null;
  eloAfter: number | null;
  eloChange: number | null;
}

export interface MatchDetail {
  matchId: number;
  roomType: 'competitive' | 'custom';
  cubeType: ApiCubeType;
  scramble: string;
  roomCode: string | null;
  winnerId: number | null;
  spectatorCount: number;
  startedAt: string;
  finishedAt: string | null;
  ratingApplied: boolean;
  /** เรียงตาม `rankNo` แล้ว (ผู้ชนะอยู่บนสุด) */
  players: MatchDetailPlayer[];
}

const STATUS_OF: Record<SolveResult, SolveStatus> = {
  [SolveResult.SOLVED]: 'solved',
  [SolveResult.DNF]: 'dnf',
  [SolveResult.SURRENDERED]: 'surrendered',
};

/**
 * ผลของแมตช์ 1v1 หนึ่งแมตช์ (api-contract.md ข้อ 3)
 *
 * ใช้ตอน client **ไม่ได้รับ `match:finished`** — กด F5 หลังรอบจบ หรือผู้ชมเพิ่งเข้าห้องที่จบแล้ว
 * `rankNo` ไม่ได้เก็บใน DB จึงคำนวณใหม่จากเวลาด้วย `assignRanks` ตัวเดียวกับตอนจบแมตช์จริง
 */
export async function getMatchDetail(matchId: number): Promise<MatchDetail> {
  const match = await prisma.match.findUnique({
    where: { matchId },
    include: {
      player1: { select: { userId: true, username: true, nickname: true } },
      player2: { select: { userId: true, username: true, nickname: true } },
    },
  });
  if (!match) throw errors.notFound('ไม่พบแมตช์นี้');

  const sides = [
    {
      user: match.player1,
      seatNo: 1 as const,
      time: match.player1Time,
      result: match.player1Result,
      moveCount: match.player1MoveCount,
      eloBefore: match.player1EloBefore,
      eloChange: match.player1EloChange,
    },
    {
      user: match.player2,
      seatNo: 2 as const,
      time: match.player2Time,
      result: match.player2Result,
      moveCount: match.player2MoveCount,
      eloBefore: match.player2EloBefore,
      eloChange: match.player2EloChange,
    },
  ];

  const ranks = assignRanks(
    sides.map((side) => ({
      userId: side.user.userId,
      status: STATUS_OF[side.result],
      // assignRanks คิดเป็นมิลลิวินาที ส่วน DB เก็บวินาทีทศนิยม 2 ตำแหน่ง
      solveTimeMs: side.time === null ? null : Math.round(side.time.toNumber() * 1000),
    })),
  );

  const players: MatchDetailPlayer[] = sides
    .map((side) => ({
      userId: side.user.userId,
      username: side.user.username,
      nickname: side.user.nickname,
      seatNo: side.seatNo,
      rankNo: ranks.get(side.user.userId) ?? 1,
      solveTime: side.time === null ? null : side.time.toNumber(),
      result: STATUS_OF[side.result],
      moveCount: side.moveCount ?? 0,
      eloBefore: side.eloChange === null ? null : side.eloBefore,
      eloAfter:
        side.eloChange === null || side.eloBefore === null ? null : side.eloBefore + side.eloChange,
      eloChange: side.eloChange,
    }))
    .sort((a, b) => a.rankNo - b.rankNo);

  return {
    matchId: match.matchId,
    roomType: match.roomType === RoomType.COMPETITIVE ? 'competitive' : 'custom',
    cubeType: PRISMA_TO_CUBE_TYPE[match.cubeType],
    scramble: match.scramble,
    roomCode: match.roomCode,
    winnerId: match.winnerId,
    spectatorCount: match.spectatorCount,
    startedAt: match.startedAt.toISOString(),
    finishedAt: match.finishedAt?.toISOString() ?? null,
    ratingApplied: match.roomType === RoomType.COMPETITIVE,
    players,
  };
}
