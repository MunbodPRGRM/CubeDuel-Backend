/**
 * สูตร Elo — ต้องตรงกับ `CLAUDE.md` ข้อ 7 เป๊ะ (K = 32 คงที่ ไม่มี K แปรผันตามระดับ)
 *
 * ทุกฟังก์ชันในไฟล์นี้เป็น pure — ไม่แตะ DB ไม่แตะห้อง เพื่อให้เขียนเทสตรง ๆ ได้
 * (`src/lib/elo.test.ts` — รันด้วย `npm test`)
 */
import { ELO_K_FACTOR } from '../constants.js';

/** S ในสูตร — 1 ชนะ / 0.5 เสมอ / 0 แพ้ (DNF และยอมแพ้นับเป็นแพ้) */
export type EloScore = 0 | 0.5 | 1;

/** E = 1 / (1 + 10^((Ropp - Rself) / 400)) */
export function expectedScore(ratingSelf: number, ratingOpponent: number): number {
  return 1 / (1 + Math.pow(10, (ratingOpponent - ratingSelf) / 400));
}

/**
 * ปัดครึ่งออกจากศูนย์ (2.5 → 3 · -2.5 → -3)
 *
 * `Math.round` ปัดครึ่ง**ขึ้น**เสมอ (-2.5 → -2) ซึ่งจะทำให้ delta ของสองฝั่งไม่หักล้างกันพอดี
 * ถ้า K·(S−E) ลงตัวที่ .5 — คะแนนรวมของทั้งระบบจะงอกขึ้นมาเองทีละ 1 แต้ม
 * (ในช่วง Elo ที่ใช้จริงยังไม่เจอค่าแบบนั้น แต่กันไว้ให้คุณสมบัติ "ผลรวมเป็นศูนย์" เป็นจริงเสมอ)
 */
function roundHalfAwayFromZero(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  // -0 ทำให้เทสและ JSON เพี้ยนโดยไม่จำเป็น
  return rounded === 0 ? 0 : rounded;
}

/**
 * ส่วนต่างของคะแนนหลังจบแมตช์ — Δ = round(K * (S - E))
 *
 * ใช้ตัวนี้เป็นหลัก (ไม่ใช่ `newRating`) เพราะสิ่งที่ลง DB คือ `elo_change`
 * และ Δ ของสองฝั่งต้องรวมกันได้ศูนย์เสมอ
 */
export function ratingDelta(ratingSelf: number, ratingOpponent: number, score: EloScore): number {
  return roundHalfAwayFromZero(ELO_K_FACTOR * (score - expectedScore(ratingSelf, ratingOpponent)));
}

/** R' = R + K * (S - E) */
export function newRating(ratingSelf: number, ratingOpponent: number, score: EloScore): number {
  return ratingSelf + ratingDelta(ratingSelf, ratingOpponent, score);
}

/** อันดับในแมตช์ → S ของฝั่งนั้น (อันดับเท่ากัน = เสมอ — ADR-007) */
export function scoreFromRanks(rankSelf: number, rankOpponent: number): EloScore {
  if (rankSelf === rankOpponent) return 0.5;
  return rankSelf < rankOpponent ? 1 : 0;
}

/** ฝั่งหนึ่งของแมตช์ 1v1 ที่พร้อมคิดคะแนนแล้ว */
export interface DuelSide {
  userId: number;
  /** Elo ของ `cube_type` ที่แข่ง **ก่อน** แมตช์นี้ */
  eloRating: number;
  /** อันดับที่ได้จาก `assignRanks()` — DNF ทั้งคู่ได้อันดับเท่ากัน */
  rankNo: number;
}

/**
 * Δ ของทั้งสองฝั่งในแมตช์ 1v1 — คืน `Map<userId, delta>`
 *
 * ครอบทุกเคสที่กติกาให้ผลเสมอ: เวลาเท่ากันเป๊ะ · DNF ทั้งคู่ · ยอมแพ้ทั้งคู่
 * (ทั้งหมดได้อันดับเท่ากันมาจาก `assignRanks()` แล้ว จึงคิดเป็น S = 0.5 ทั้งคู่)
 */
export function duelEloChanges(sides: readonly [DuelSide, DuelSide]): Map<number, number> {
  const [first, second] = sides;
  return new Map([
    [
      first.userId,
      ratingDelta(first.eloRating, second.eloRating, scoreFromRanks(first.rankNo, second.rankNo)),
    ],
    [
      second.userId,
      ratingDelta(second.eloRating, first.eloRating, scoreFromRanks(second.rankNo, first.rankNo)),
    ],
  ]);
}

// ---------------------------------------------------------------- ห้องผู้เล่นหลายคน

/**
 * Pairwise Elo ของห้องผู้เล่นหลายคน (N = 3 หรือ 4 · โหมด auto เท่านั้น — CLAUDE.md ข้อ 7)
 *
 *   1. จับผลของผู้เล่นทุกคู่ในห้อง เสมือนแข่ง 1v1 ทีละคู่
 *   2. คิด delta ของแต่ละคู่ด้วย `ratingDelta()` ตัวเดียวกับ 1v1 (K = 32)
 *   3. คะแนนจริงของแต่ละคน = ผลรวม delta ทุกคู่ที่ตัวเองเกี่ยวข้อง ÷ (N − 1)
 *
 * ที่ N = 2 สูตรนี้ยุบลงเป็น `duelEloChanges()` พอดี (หารด้วย 1) — ห้อง 1v1 จึงยังใช้ตัวเดิมได้
 * โดยไม่มีทางให้ผลต่างกัน
 *
 * **ผลรวม delta ของทั้งห้องเป็นศูนย์เสมอ** — delta ของแต่ละคู่หักล้างกันพอดีอยู่แล้ว
 * แต่การหารด้วย (N−1) ทำให้เกิดเศษ .5 ได้ ถ้าปัดของแต่ละคนแยกกันดื้อ ๆ คะแนนรวมจะงอก/หายไป
 * จึงปัดด้วย **largest remainder**: ปัดตามปกติก่อน แล้วเกลี่ยส่วนที่ยังขาด/เกินไปให้คนที่ถูกปัด
 * ทิ้งมากที่สุดคนละ 1 แต้ม (ไม่เกิน ⌊N/2⌋ คน)
 */
export function pairwiseEloChanges(sides: readonly DuelSide[]): Map<number, number> {
  if (sides.length < 2) return new Map(sides.map((side) => [side.userId, 0]));

  // 1 + 2 — ผลรวม delta ของทุกคู่ (จำนวนเต็ม และรวมทั้งห้องได้ศูนย์)
  const totals = new Map<number, number>(sides.map((side) => [side.userId, 0]));
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      const self = sides[i]!;
      const other = sides[j]!;
      const delta = ratingDelta(
        self.eloRating,
        other.eloRating,
        scoreFromRanks(self.rankNo, other.rankNo),
      );
      totals.set(self.userId, totals.get(self.userId)! + delta);
      totals.set(other.userId, totals.get(other.userId)! - delta);
    }
  }

  // 3 — หารด้วย (N−1) แล้วปัด พร้อมจำ "เศษที่ถูกปัดทิ้ง" ไว้เกลี่ยทีหลัง
  const divisor = sides.length - 1;
  const changes = new Map<number, number>();
  const remainders: { userId: number; remainder: number }[] = [];
  let sum = 0;
  for (const side of sides) {
    const exact = totals.get(side.userId)! / divisor;
    const rounded = roundHalfAwayFromZero(exact);
    changes.set(side.userId, rounded);
    remainders.push({ userId: side.userId, remainder: exact - rounded });
    sum += rounded;
  }

  /**
   * เกลี่ยส่วนที่เกิน/ขาดให้ผลรวมกลับมาเป็นศูนย์ — ให้คนที่ถูกปัดทิ้งมากที่สุดก่อน
   * ถ้าเศษเท่ากัน (เกิดบ่อยมากในห้อง 3 คนที่หารด้วย 2) ให้คนที่ **เข้าห้องก่อน**
   *
   * ต้องปัดเศษก่อนเปรียบเทียบ เพราะ 16/3 กับ −32/3 ทิ้งเศษ ⅓ เท่ากันในทางคณิตศาสตร์
   * แต่ต่างกันที่หลักที่ 16 ของ floating point — ถ้าเทียบดิบ ๆ ผู้ได้แต้มพิเศษจะถูกเลือก
   * ด้วยความคลาดเคลื่อนของเลขทศนิยม ไม่ใช่ด้วยกติกาที่อธิบายได้
   */
  let residual = -sum;
  if (residual !== 0) {
    const step = residual > 0 ? 1 : -1;
    const key = (value: number) => Math.round(value * 1e6);
    // `sort` ของ JS เสถียร → เศษเท่ากันจะคงลำดับที่ส่งเข้ามา (ลำดับที่นั่งในห้อง)
    const order = [...remainders].sort((a, b) =>
      step > 0 ? key(b.remainder) - key(a.remainder) : key(a.remainder) - key(b.remainder),
    );
    for (const entry of order) {
      if (residual === 0) break;
      changes.set(entry.userId, changes.get(entry.userId)! + step);
      residual -= step;
    }
  }

  // -0 ลง JSON แล้วอ่านยาก (ตัวเดียวกับที่ `roundHalfAwayFromZero` กันไว้)
  for (const [userId, value] of changes) if (value === 0) changes.set(userId, 0);
  return changes;
}
