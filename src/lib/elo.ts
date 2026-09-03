import { ELO_K_FACTOR } from '../constants.js';

/** E = 1 / (1 + 10^((Ropp - Rself) / 400)) */
export function expectedScore(ratingSelf: number, ratingOpponent: number): number {
  return 1 / (1 + Math.pow(10, (ratingOpponent - ratingSelf) / 400));
}

/** R' = R + K * (S - E) — S: 1 ชนะ / 0.5 เสมอ / 0 แพ้ */
export function newRating(ratingSelf: number, ratingOpponent: number, score: 0 | 0.5 | 1): number {
  return Math.round(ratingSelf + ELO_K_FACTOR * (score - expectedScore(ratingSelf, ratingOpponent)));
}

// TODO(เฟส 6): pairwiseElo() สำหรับห้องหลายคน + unit test
