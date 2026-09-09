/**
 * unit test ของสูตร Elo — `CLAUDE.md` ข้อ 7 (เฟส 5 ก้อนที่ 1)
 * รันด้วย `npm test`
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ELO_K_FACTOR } from '../constants.js';
import {
  duelEloChanges,
  expectedScore,
  newRating,
  pairwiseEloChanges,
  ratingDelta,
  scoreFromRanks,
} from './elo.js';

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

// ---------------------------------------------------------------- Pairwise Elo (เฟส 6 ก้อนที่ 1)

describe('pairwiseEloChanges', () => {
  /** ผู้เล่นหนึ่งคนพร้อมอันดับ — ย่อให้เทสอ่านง่าย */
  const side = (userId: number, eloRating: number, rankNo: number) => ({
    userId,
    eloRating,
    rankNo,
  });
  const sum = (changes: Map<number, number>) => [...changes.values()].reduce((a, b) => a + b, 0);

  it('N = 2 ให้ผลเหมือน duelEloChanges เป๊ะ (สูตรเดียวกัน หารด้วย 1)', () => {
    for (const [selfElo, otherElo] of [
      [1000, 1000],
      [1000, 1200],
      [1600, 1000],
      [1234, 987],
    ]) {
      for (const [rankA, rankB] of [
        [1, 2],
        [2, 1],
        [1, 1],
        [2, 2],
      ]) {
        const pair = [side(1, selfElo!, rankA!), side(2, otherElo!, rankB!)] as const;
        assert.deepEqual(
          [...pairwiseEloChanges(pair)],
          [...duelEloChanges(pair)],
          `${selfElo} (อันดับ ${rankA}) vs ${otherElo} (อันดับ ${rankB})`,
        );
      }
    }
  });

  it('3 คนคะแนนเท่ากัน แพ้ชนะเรียงกัน → +16 / 0 / -16 (แต่ละคู่ ±16 แล้วหาร 2)', () => {
    const changes = pairwiseEloChanges([
      side(1, 1000, 1),
      side(2, 1000, 2),
      side(3, 1000, 3),
    ]);
    assert.equal(changes.get(1), 16);
    assert.equal(changes.get(2), 0);
    assert.equal(changes.get(3), -16);
    assert.equal(sum(changes), 0);
  });

  it('4 คนคะแนนเท่ากัน → ชนะทุกคู่ +16 · แพ้ทุกคู่ -16 · ตรงกลางเกลี่ยกันเอง', () => {
    const changes = pairwiseEloChanges([
      side(1, 1000, 1),
      side(2, 1000, 2),
      side(3, 1000, 3),
      side(4, 1000, 4),
    ]);
    // อันดับ 1 ชนะ 3 คู่ = +48 / 3 = +16 · อันดับ 2 ชนะ 2 แพ้ 1 = +16 / 3 ≈ 5
    assert.equal(changes.get(1), 16);
    assert.equal(changes.get(2), 5);
    assert.equal(changes.get(3), -5);
    assert.equal(changes.get(4), -16);
    assert.equal(sum(changes), 0);
  });

  it('DNF แพ้ทุกคู่ที่เทียบด้วย (อันดับท้ายสุดร่วมกัน) แต่ DNF ด้วยกันถือว่าเสมอกันเอง', () => {
    // A แก้เสร็จคนเดียว · B กับ C DNF → assignRanks ให้ B, C อันดับ 2 เท่ากัน
    const changes = pairwiseEloChanges([side(1, 1000, 1), side(2, 1000, 2), side(3, 1000, 2)]);
    assert.equal(changes.get(1), 16); // ชนะทั้ง 2 คู่ = +32 / 2
    assert.equal(changes.get(2), -8); // แพ้ A (-16) + เสมอ C (0) = -16 / 2
    assert.equal(changes.get(3), -8);
    assert.equal(sum(changes), 0);
  });

  it('DNF ทั้งห้อง (อันดับ 1 เท่ากันหมด) = เสมอทุกคู่ → คะแนนเท่ากันไม่มีใครขยับ', () => {
    const changes = pairwiseEloChanges([
      side(1, 1000, 1),
      side(2, 1000, 1),
      side(3, 1000, 1),
      side(4, 1000, 1),
    ]);
    for (const userId of [1, 2, 3, 4]) assert.equal(changes.get(userId), 0);
    assert.equal(sum(changes), 0);
  });

  it('เวลาเท่ากันเป๊ะ = เสมอเฉพาะคู่นั้น คู่อื่นยังตัดสินแพ้ชนะตามปกติ', () => {
    // A กับ B เวลาเท่ากัน (อันดับ 1 ทั้งคู่) · C ช้ากว่า (อันดับ 3)
    const changes = pairwiseEloChanges([side(1, 1000, 1), side(2, 1000, 1), side(3, 1000, 3)]);
    assert.equal(changes.get(1), 8); // เสมอ B (0) + ชนะ C (+16) = 16 / 2
    assert.equal(changes.get(2), 8);
    assert.equal(changes.get(3), -16);
    assert.equal(sum(changes), 0);
  });

  it('คะแนนต่างกัน: ชนะคนที่อ่อนกว่ามากได้น้อย · แพ้คนที่อ่อนกว่าเสียเยอะ', () => {
    const changes = pairwiseEloChanges([
      side(1, 1600, 3), // แข็งที่สุดแต่มาที่โหล่
      side(2, 1000, 1),
      side(3, 1000, 2),
    ]);
    assert.ok(changes.get(1)! < -20, `แพ้ทั้งสองคู่ต้องเสียเยอะ: ${changes.get(1)}`);
    assert.ok(changes.get(2)! > 0);
    assert.ok(changes.get(3)! > 0);
    assert.equal(sum(changes), 0);
  });

  it('ผลรวม delta ของทั้งห้องเป็นศูนย์เสมอ ทุกส่วนผสมของคะแนนและอันดับ', () => {
    const elos = [873, 1000, 1204, 1631];
    const rankSets = [
      [1, 2, 3, 4],
      [1, 1, 3, 4],
      [1, 1, 1, 4],
      [1, 2, 2, 4],
      [1, 1, 1, 1],
      [2, 2, 2, 1],
      [3, 1, 2, 3],
    ];
    for (const ranks of rankSets) {
      for (let shift = 0; shift < 4; shift++) {
        const room = ranks.map((rankNo, index) =>
          side(index + 1, elos[(index + shift) % elos.length]!, rankNo),
        );
        const changes = pairwiseEloChanges(room);
        assert.equal(sum(changes), 0, `ranks=${ranks.join(',')} shift=${shift}`);
        assert.equal(changes.size, 4);
        for (const value of changes.values()) assert.ok(Number.isInteger(value));
      }
    }
  });

  it('ห้อง 3 คนก็ต้องรวมกันได้ศูนย์ (เศษ .5 จากการหารด้วย 2 ต้องถูกเกลี่ย)', () => {
    const elos = [900, 1000, 1100, 1250, 1480];
    for (const a of elos) {
      for (const b of elos) {
        for (const c of elos) {
          for (const ranks of [
            [1, 2, 3],
            [1, 1, 3],
            [1, 2, 2],
            [1, 1, 1],
          ]) {
            const changes = pairwiseEloChanges([
              side(1, a, ranks[0]!),
              side(2, b, ranks[1]!),
              side(3, c, ranks[2]!),
            ]);
            assert.equal(sum(changes), 0, `${a}/${b}/${c} ranks=${ranks.join(',')}`);
          }
        }
      }
    }
  });

  it('ขยับได้ไม่เกิน K ต่อหนึ่งแมตช์ ถึงจะเทียบหลายคู่ก็ตาม', () => {
    for (const ranks of [
      [1, 2, 3, 4],
      [4, 3, 2, 1],
      [1, 1, 3, 3],
    ]) {
      const changes = pairwiseEloChanges([
        side(1, 2400, ranks[0]!),
        side(2, 1000, ranks[1]!),
        side(3, 1400, ranks[2]!),
        side(4, 800, ranks[3]!),
      ]);
      for (const value of changes.values()) assert.ok(Math.abs(value) <= ELO_K_FACTOR, `${value}`);
    }
  });

  it('เศษที่เหลือจากการหารตกกับคนที่ถูกปัดทิ้งมากที่สุด ถ้าเท่ากันให้คนที่เข้าห้องก่อน', () => {
    // ทุกคน 1000 · อันดับ 1, 2, 3, 3 → ผลรวมต่อคน +48, +16, -32, -32 หารด้วย 3
    // = 16, 5.33, -10.67, -10.67 → ปัดได้ 16, 5, -11, -11 (รวม -1) ต้องเกลี่ยคืน +1
    // ทั้งสามคนหลังทิ้งเศษ ⅓ เท่ากัน → ตกกับคนที่นั่งก่อน (userId 2)
    const changes = pairwiseEloChanges([
      side(1, 1000, 1),
      side(2, 1000, 2),
      side(3, 1000, 3),
      side(4, 1000, 3),
    ]);
    assert.deepEqual(
      [...changes],
      [
        [1, 16],
        [2, 6],
        [3, -11],
        [4, -11],
      ],
    );
    assert.equal(sum(changes), 0);
  });

  it('เศษไม่เท่ากัน → สลับลำดับที่ส่งเข้ามาก็ได้ผลเท่าเดิม (ลำดับมีผลเฉพาะตอนเศษเสมอกัน)', () => {
    const room = [side(1, 1037, 1), side(2, 1188, 2), side(3, 972, 3)];
    const forward = pairwiseEloChanges(room);
    const reversed = pairwiseEloChanges([...room].reverse());
    for (const userId of [1, 2, 3]) assert.equal(forward.get(userId), reversed.get(userId));
  });
});
