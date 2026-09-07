/**
 * บันทึกผลแมตช์ 1v1 ลง DB — **เขียนครั้งเดียวตอนจบ ในทรานแซกชันเดียว** (ADR-035 ข้อ 5)
 *
 * ในทรานแซกชันเดียวกันมี: แถว `Match` · การอัปเดตตัวเลขสรุปใน `Rating` ของทั้งสองฝั่ง
 * (ADR-014 บังคับไว้) · แถว `MatchFlag` ของ solve ที่เข้าเกณฑ์ soft (game-rules.md ข้อ 10)
 *
 * ไฟล์นี้ไม่รู้จัก Socket.IO เลย — ชั้น socket เป็นคนแปลงห้องเป็น `MatchOutcome` ให้
 */
import { Prisma, RoomType, SolveResult } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { inspectSolve, type SolveSample } from '../lib/anti-cheat.js';
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

/**
 * มิลลิวินาที → วินาทีทศนิยม 2 ตำแหน่งแบบ **ปัดลง** (game-rules.md ข้อ 3)
 * ปัดลงตามธรรมเนียม speedcubing — 12.349 วิ ต้องเป็น 12.34 ไม่ใช่ 12.35
 */
export function toDbSeconds(ms: number): number {
  return Math.floor(ms / 10) / 100;
}

/** เวลาที่ใช้เทียบกันตอนจัดอันดับ = ค่าที่จะลง DB จริง ไม่ใช่ค่ามิลลิวินาทีดิบ */
function comparableTime(player: {
  status: SolveStatus;
  solveTimeMs: number | null;
}): number | null {
  if (player.status !== 'solved' || player.solveTimeMs === null) return null;
  return toDbSeconds(player.solveTimeMs);
}

/**
 * จัดอันดับตาม `game-rules.md` ข้อ 7 — คืน `Map<userId, rankNo>`
 *
 * เร็วกว่าได้อันดับดีกว่า · เวลาเท่ากันเป๊ะได้อันดับเท่ากันแล้วอันดับถัดไปข้าม (1, 1, 3, 4)
 * · DNF ทุกคนอยู่ท้ายสุดและได้อันดับเท่ากันหมด = (จำนวนคนที่แก้สำเร็จ) + 1
 */
export function assignRanks<
  T extends { userId: number; status: SolveStatus; solveTimeMs: number | null },
>(players: readonly T[]): Map<number, number> {
  const solved = players
    .map((player) => ({ userId: player.userId, time: comparableTime(player) }))
    .filter((entry): entry is { userId: number; time: number } => entry.time !== null)
    .sort((a, b) => a.time - b.time);

  const ranks = new Map<number, number>();
  let previousTime: number | null = null;
  let previousRank = 0;

  solved.forEach((entry, index) => {
    const rank = previousTime !== null && entry.time === previousTime ? previousRank : index + 1;
    ranks.set(entry.userId, rank);
    previousTime = entry.time;
    previousRank = rank;
  });

  const dnfRank = solved.length + 1;
  for (const player of players) {
    if (!ranks.has(player.userId)) ranks.set(player.userId, dnfRank);
  }
  return ranks;
}

/** เสมอ = ไม่มีใครได้อันดับ 1 คนเดียว (เวลาเท่ากัน หรือ DNF ทั้งคู่ — ADR-007) */
export function findWinnerId(
  players: readonly { userId: number; rankNo: number; status: SolveStatus }[],
): number | null {
  const firstPlace = players.filter((player) => player.rankNo === 1 && player.status === 'solved');
  return firstPlace.length === 1 ? firstPlace[0]!.userId : null;
}

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
        await tx.matchFlag.create({
          data: {
            matchId: match.matchId,
            userId: player.userId,
            flagReason: flag.reason,
            detail: flag.detail as Prisma.InputJsonValue,
            // เก็บ move stream เฉพาะแมตช์ที่ถูก flag เท่านั้น (job ล้างเป็น NULL หลัง 90 วัน)
            moveLog: player.moveLog as unknown as Prisma.InputJsonValue,
          },
        });
      }
    }

    return match.matchId;
  });
}
