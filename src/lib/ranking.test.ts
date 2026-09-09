/**
 * unit test ของการจัดอันดับและการตัดสินผู้ชนะ — `docs/game-rules.md` ข้อ 3 + 7
 * เน้นเคสเสมอ/DNF ที่ทำให้ `winner_id` ต้องเป็น NULL (เฟส 5 ก้อนที่ 1)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignRanks, findWinnerId, toDbSeconds } from './ranking.js';

type Player = {
  userId: number;
  status: 'solving' | 'solved' | 'dnf' | 'surrendered';
  solveTimeMs: number | null;
};

const solved = (userId: number, solveTimeMs: number): Player => ({
  userId,
  status: 'solved',
  solveTimeMs,
});
const dnf = (userId: number, status: Player['status'] = 'dnf'): Player => ({
  userId,
  status,
  solveTimeMs: null,
});

describe('toDbSeconds', () => {
  it('ปัดลงเป็นทศนิยม 2 ตำแหน่งตามธรรมเนียม speedcubing', () => {
    assert.equal(toDbSeconds(12349), 12.34);
    assert.equal(toDbSeconds(12350), 12.35);
    assert.equal(toDbSeconds(999), 0.99);
    assert.equal(toDbSeconds(0), 0);
  });
});

describe('assignRanks', () => {
  it('เร็วกว่าได้อันดับดีกว่า', () => {
    const ranks = assignRanks([solved(1, 9_000), solved(2, 5_000)]);
    assert.equal(ranks.get(2), 1);
    assert.equal(ranks.get(1), 2);
  });

  it('เวลาต่างกันแค่หลักมิลลิวินาทีที่ 3 = เท่ากัน เพราะเทียบที่ค่าซึ่งลง DB จริง', () => {
    const ranks = assignRanks([solved(1, 5_001), solved(2, 5_009)]);
    assert.equal(ranks.get(1), 1);
    assert.equal(ranks.get(2), 1);
  });

  it('เวลาเท่ากันได้อันดับเท่ากัน แล้วอันดับถัดไปข้าม (1, 1, 3)', () => {
    const ranks = assignRanks([solved(1, 5_000), solved(2, 5_000), solved(3, 7_000)]);
    assert.equal(ranks.get(1), 1);
    assert.equal(ranks.get(2), 1);
    assert.equal(ranks.get(3), 3);
  });

  it('DNF อยู่ท้ายสุดและได้อันดับเท่ากันหมด = คนที่แก้สำเร็จ + 1', () => {
    const ranks = assignRanks([solved(1, 5_000), dnf(2), dnf(3, 'surrendered'), dnf(4, 'solving')]);
    assert.equal(ranks.get(1), 1);
    assert.equal(ranks.get(2), 2);
    assert.equal(ranks.get(3), 2);
    assert.equal(ranks.get(4), 2);
  });

  it('DNF ทั้งคู่ได้อันดับ 1 เท่ากัน (ไม่มีใครแก้สำเร็จ) → ตกเป็นเสมอตอนคิด Elo', () => {
    const ranks = assignRanks([dnf(1), dnf(2, 'surrendered')]);
    assert.equal(ranks.get(1), 1);
    assert.equal(ranks.get(2), 1);
  });
});

describe('findWinnerId', () => {
  const withRanks = (players: Player[]) => {
    const ranks = assignRanks(players);
    return players.map((player) => ({
      userId: player.userId,
      status: player.status,
      rankNo: ranks.get(player.userId)!,
    }));
  };

  it('คนที่เร็วกว่าเป็นผู้ชนะ', () => {
    assert.equal(findWinnerId(withRanks([solved(1, 9_000), solved(2, 5_000)])), 2);
  });

  it('เวลาเท่ากัน → ไม่มีผู้ชนะ (winner_id = NULL)', () => {
    assert.equal(findWinnerId(withRanks([solved(1, 5_000), solved(2, 5_000)])), null);
  });

  it('DNF ทั้งคู่ → ไม่มีผู้ชนะ ถึงจะได้อันดับ 1 เท่ากันก็ตาม', () => {
    assert.equal(findWinnerId(withRanks([dnf(1), dnf(2)])), null);
  });

  it('ยอมแพ้ทั้งคู่ → ไม่มีผู้ชนะ', () => {
    assert.equal(findWinnerId(withRanks([dnf(1, 'surrendered'), dnf(2, 'surrendered')])), null);
  });

  it('อีกฝ่าย DNF → คนที่แก้เสร็จชนะ', () => {
    assert.equal(findWinnerId(withRanks([solved(1, 5_000), dnf(2, 'surrendered')])), 1);
  });
});
