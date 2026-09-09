/**
 * จัดอันดับและตัดสินผู้ชนะของแมตช์ — `docs/game-rules.md` ข้อ 3 + 7
 *
 * แยกออกมาจาก `services/match.service.ts` เพราะเป็นตรรกะการตัดสินล้วน ๆ ไม่แตะ DB
 * (ตัวตัดสินเสมอ/DNF ต้องเขียนเทสได้ตรง ๆ โดยไม่ต้องมี Prisma — เฟส 5 ก้อนที่ 1)
 */
import type { SolveStatus } from '../sockets/types.js';

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
