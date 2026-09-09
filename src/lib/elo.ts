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

// TODO(เฟส 6): pairwiseElo() สำหรับห้องหลายคน + unit test
