/**
 * บันทึกผลแมตช์ 1v1 ลง DB — **เขียนครั้งเดียวตอนจบ ในทรานแซกชันเดียว** (ADR-035 ข้อ 5)
 *
 * ในทรานแซกชันเดียวกันมี: แถว `Match` · การอัปเดตตัวเลขสรุปใน `Rating` ของทั้งสองฝั่ง
 * (ADR-014 บังคับไว้) · แถว `MatchFlag` ของ solve ที่เข้าเกณฑ์ soft (game-rules.md ข้อ 10)
 *
 * ไฟล์นี้ไม่รู้จัก Socket.IO เลย — ชั้น socket เป็นคนแปลงห้องเป็น `MatchOutcome` ให้
 */
import {
  Prisma,
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
import { toDbSeconds } from '../lib/ranking.js';
import { CUBE_TYPE_TO_PRISMA, type ApiCubeType } from '../types/cube.js';
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

/** ตัวเขียน `MatchFlag` ตัวเดียวของไฟล์นี้ — ทุก flag ต้องผ่านทางนี้ (จะได้เก็บ move_log เหมือนกัน) */
async function writeFlag(
  tx: Prisma.TransactionClient,
  matchId: number,
  player: MatchPlayerOutcome,
  flag: { reason: FlagReason; detail: Record<string, unknown> },
): Promise<void> {
  await tx.matchFlag.create({
    data: {
      matchId,
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
  if (flag) await writeFlag(tx, matchId, winner, flag);
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

    for (const player of [player1, player2]) {
      const current = await tx.rating.findUnique({
        where: { userId_cubeType: { userId: player.userId, cubeType } },
        select: { bestTime: true },
      });

      const time = sideData(player).time;
      // best_time นับเฉพาะ solve ที่สำเร็จ และนับห้องสร้างเองด้วย (ADR-035 ข้อ 4)
      const improved =
        time !== null &&
        (current?.bestTime === null ||
          current?.bestTime === undefined ||
          time.lessThan(current.bestTime));

      await tx.rating.update({
        where: { userId_cubeType: { userId: player.userId, cubeType } },
        data: {
          matchesPlayed: { increment: 1 },
          wins: { increment: outcome.winnerId === player.userId ? 1 : 0 },
          losses: {
            increment: outcome.winnerId !== null && outcome.winnerId !== player.userId ? 1 : 0,
          },
          draws: { increment: outcome.winnerId === null ? 1 : 0 },
          ...(improved ? { bestTime: time } : {}),
          ...(player.eloChange === null ? {} : { eloRating: { increment: player.eloChange } }),
        },
      });

      if (player.status !== 'solved' || player.solveTimeMs === null) continue;

      const sample: SolveSample = {
        cubeType: outcome.cubeType,
        solveTimeMs: player.solveTimeMs,
        moveCount: player.moveCount,
        moveTimestampsMs: player.moveTimestampsMs,
      };
      for (const flag of inspectSolve(sample)) {
        await writeFlag(tx, match.matchId, player, flag);
      }
    }

    await flagWinStreak(tx, match.matchId, outcome, cubeType);

    return match.matchId;
  });
}
