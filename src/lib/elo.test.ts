/**
 * unit test ของสูตร Elo — `CLAUDE.md` ข้อ 7 (เฟส 5 ก้อนที่ 1)
 * รันด้วย `npm test`
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ELO_K_FACTOR } from '../constants.js';
import { duelEloChanges, expectedScore, newRating, ratingDelta, scoreFromRanks } from './elo.js';

describe('expectedScore', () => {
  it('คะแนนเท่ากัน → โอกาสชนะ 50%', () => {
    assert.equal(expectedScore(1000, 1000), 0.5);
    assert.equal(expectedScore(1873, 1873), 0.5);
  });

  it('สูงกว่า 400 แต้ม → ราว 90.9% (ค่ามาตรฐานของสูตร)', () => {
    assert.ok(Math.abs(expectedScore(1400, 1000) - 0.9091) < 0.0001);
    assert.ok(Math.abs(expectedScore(1000, 1400) - 0.0909) < 0.0001);
  });

  it('โอกาสของสองฝั่งรวมกันได้ 1 เสมอ', () => {
    for (const [a, b] of [
      [1000, 1000],
      [1000, 1237],
      [800, 2400],
      [1500, 1499],
    ]) {
      assert.ok(Math.abs(expectedScore(a!, b!) + expectedScore(b!, a!) - 1) < 1e-12);
    }
  });
});

describe('ratingDelta / newRating', () => {
  it('คะแนนเท่ากัน: ชนะ +16 · แพ้ -16 · เสมอ 0 (K = 32)', () => {
    assert.equal(ratingDelta(1000, 1000, 1), 16);
    assert.equal(ratingDelta(1000, 1000, 0), -16);
    assert.equal(ratingDelta(1000, 1000, 0.5), 0);
    assert.equal(newRating(1000, 1000, 1), 1016);
    assert.equal(newRating(1000, 1000, 0), 984);
    assert.equal(newRating(1000, 1000, 0.5), 1000);
  });

  it('คะแนนห่างมาก: ชนะคนอ่อนกว่าได้น้อย · แพ้คนอ่อนกว่าเสียเยอะ', () => {
    // E = 0.9091 → ชนะได้ 32 * 0.0909 ≈ 3 · แพ้เสีย 32 * 0.9091 ≈ 29
    assert.equal(ratingDelta(1400, 1000, 1), 3);
    assert.equal(ratingDelta(1400, 1000, 0), -29);
    // ฝั่งตรงข้ามเป็นภาพสะท้อนพอดี
    assert.equal(ratingDelta(1000, 1400, 0), -3);
    assert.equal(ratingDelta(1000, 1400, 1), 29);
  });

  it('เสมอกับคนที่แข็งกว่าได้คะแนน · เสมอกับคนที่อ่อนกว่าเสียคะแนน', () => {
    assert.ok(ratingDelta(1000, 1400, 0.5) > 0);
    assert.ok(ratingDelta(1400, 1000, 0.5) < 0);
  });

  it('ขยับได้ไม่เกิน K ต่อหนึ่งแมตช์', () => {
    for (let self = 400; self <= 2800; self += 37) {
      for (let opponent = 400; opponent <= 2800; opponent += 53) {
        for (const score of [0, 0.5, 1] as const) {
          assert.ok(Math.abs(ratingDelta(self, opponent, score)) <= ELO_K_FACTOR);
        }
      }
    }
  });

  it('ผลลัพธ์เป็นจำนวนเต็มเสมอ (คอลัมน์ elo_rating เป็น Int)', () => {
    for (let opponent = 400; opponent <= 2800; opponent += 7) {
      for (const score of [0, 0.5, 1] as const) {
        assert.ok(Number.isInteger(ratingDelta(1234, opponent, score)));
      }
    }
  });

  it('ผลรวม delta ของสองฝั่งเป็นศูนย์เสมอ (คะแนนไม่งอกออกมาจากไหน)', () => {
    for (let self = 100; self <= 3000; self += 13) {
      for (let opponent = 100; opponent <= 3000; opponent += 29) {
        assert.equal(
          ratingDelta(self, opponent, 1) + ratingDelta(opponent, self, 0),
          0,
          `ชนะ/แพ้ ที่ ${self} vs ${opponent}`,
        );
        assert.equal(
          ratingDelta(self, opponent, 0.5) + ratingDelta(opponent, self, 0.5),
          0,
          `เสมอ ที่ ${self} vs ${opponent}`,
        );
      }
    }
  });

  it('ปัดเศษเข้าหาจำนวนเต็มที่ใกล้ที่สุด และปัดสองฝั่งไปทางเดียวกัน', () => {
    // ต่างกัน 200 แต้ม เสมอ → K * (0.5 - E) = ±8.31 → ±8 (ไม่ใช่ +8/-9)
    assert.equal(ratingDelta(1000, 1200, 0.5), 8);
    assert.equal(ratingDelta(1200, 1000, 0.5), -8);
    // 1400 ชนะ 1000 → 32 * 0.0909 = 2.91 → 3 · ฝั่งที่แพ้ -29.09 → -29
    assert.equal(ratingDelta(1400, 1000, 1), 3);
    assert.equal(ratingDelta(1000, 1400, 0), -3);
  });
});

describe('scoreFromRanks', () => {
  it('อันดับดีกว่า = ชนะ · แย่กว่า = แพ้ · เท่ากัน = เสมอ', () => {
    assert.equal(scoreFromRanks(1, 2), 1);
    assert.equal(scoreFromRanks(2, 1), 0);
    assert.equal(scoreFromRanks(1, 1), 0.5);
    // DNF ทั้งคู่ได้อันดับเท่ากันจาก assignRanks() → เสมอ (ADR-007)
    assert.equal(scoreFromRanks(2, 2), 0.5);
  });
});

describe('duelEloChanges', () => {
  const alice = { userId: 1, eloRating: 1000 };
  const bob = { userId: 2, eloRating: 1200 };

  it('ผู้ชนะได้เท่ากับที่ผู้แพ้เสีย', () => {
    const changes = duelEloChanges([
      { ...alice, rankNo: 1 },
      { ...bob, rankNo: 2 },
    ]);
    assert.equal(changes.get(1)! + changes.get(2)!, 0);
    assert.ok(changes.get(1)! > 0);
    assert.ok(changes.get(2)! < 0);
  });

  it('เวลาเท่ากันเป๊ะ (อันดับ 1 ทั้งคู่) = เสมอ — คนที่คะแนนน้อยกว่าได้คะแนน', () => {
    const changes = duelEloChanges([
      { ...alice, rankNo: 1 },
      { ...bob, rankNo: 1 },
    ]);
    assert.equal(changes.get(1), 8);
    assert.equal(changes.get(2), -8);
  });

  it('DNF/ยอมแพ้ทั้งคู่ (อันดับท้ายเท่ากัน) = เสมอ ไม่ใช่แพ้ทั้งคู่', () => {
    const changes = duelEloChanges([
      { ...alice, rankNo: 1 },
      { ...bob, rankNo: 1 },
    ]);
    const bothDnf = duelEloChanges([
      { ...alice, rankNo: 2 },
      { ...bob, rankNo: 2 },
    ]);
    assert.deepEqual([...bothDnf], [...changes]);
  });

  it('คนเดียวที่แก้เสร็จชนะคนที่ DNF (อันดับ 1 vs 2)', () => {
    const changes = duelEloChanges([
      { ...bob, rankNo: 1 },
      { ...alice, rankNo: 2 },
    ]);
    assert.equal(changes.get(2), 8);
    assert.equal(changes.get(1), -8);
  });

  it('คะแนนเท่ากันแล้วเสมอ → ไม่มีใครขยับ', () => {
    const changes = duelEloChanges([
      { userId: 1, eloRating: 1000, rankNo: 1 },
      { userId: 2, eloRating: 1000, rankNo: 1 },
    ]);
    assert.equal(changes.get(1), 0);
    assert.equal(changes.get(2), 0);
    // ต้องเป็น 0 จริง ไม่ใช่ -0 (ลง JSON แล้วอ่านยาก)
    assert.ok(Object.is(changes.get(1), 0));
  });
});
