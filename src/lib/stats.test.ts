/**
 * unit test ของสถิติผู้เล่น — `docs/api-contract.md` ข้อ 4
 * เน้นเคสที่พลาดกันบ่อย: DNF ใน average, จำนวน solve ไม่ครบ N, สตรีคขาด (เฟส 7 ก้อนที่ 1)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  averageOfN,
  bestTime,
  meanTime,
  roundSeconds,
  winRateOf,
  winStreaks,
  worstTime,
  type MatchOutcomeForUser,
} from './stats.js';

/** 1..n เป็นวินาที — ใช้เป็นชุด solve ที่ครบจำนวนพอดีแบบอ่านง่าย */
const seconds = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('roundSeconds', () => {
  it('ปัดครึ่งขึ้นเป็นทศนิยม 2 ตำแหน่ง', () => {
    assert.equal(roundSeconds(12.344), 12.34);
    assert.equal(roundSeconds(12.345), 12.35);
    assert.equal(roundSeconds(10), 10);
  });

  it('ไม่ทิ้งเศษจาก floating point (1.005 ต้องได้ 1.01 ไม่ใช่ 1)', () => {
    assert.equal(roundSeconds(1.005), 1.01);
  });
});

describe('bestTime / worstTime / meanTime', () => {
  it('ไม่นับ DNF ทั้งสามตัว', () => {
    const times = [12.5, null, 9.87, 41.02, null];
    assert.equal(bestTime(times), 9.87);
    assert.equal(worstTime(times), 41.02);
    assert.equal(meanTime(times), roundSeconds((12.5 + 9.87 + 41.02) / 3));
  });

  it('ยังไม่เคยแก้สำเร็จเลย = null ทั้งสามตัว ไม่ใช่ 0', () => {
    assert.equal(bestTime([null, null]), null);
    assert.equal(worstTime([null, null]), null);
    assert.equal(meanTime([null, null]), null);
  });

  it('ไม่มี solve เลย = null', () => {
    assert.equal(bestTime([]), null);
    assert.equal(meanTime([]), null);
  });
});

describe('averageOfN', () => {
  it('ตัดเร็วสุด 1 + ช้าสุด 1 แล้วเฉลี่ยที่เหลือ', () => {
    // 1..5 → ตัด 1 กับ 5 เหลือ 2,3,4
    assert.equal(averageOfN(seconds(5), 5), 3);
  });

  it('ใช้ N ครั้งล่าสุดเท่านั้น ตัวเก่ากว่านั้นไม่มีผล', () => {
    // ใหม่→เก่า: 10,20,30,40,50 แล้วต่อด้วยตัวเก่าที่ช้ามาก
    const recentFirst = [10, 20, 30, 40, 50, 999, 999];
    assert.equal(averageOfN(recentFirst, 5), 30);
  });

  it('DNF 1 ครั้ง = ช้าที่สุด ถูกตัดทิ้งพร้อมตัวที่เร็วที่สุด', () => {
    // 1..4 + DNF → ตัด DNF (ช้าสุด) กับ 1 (เร็วสุด) เหลือ 2,3,4
    assert.equal(averageOfN([null, 1, 2, 3, 4], 5), 3);
  });

  it('DNF 2 ครั้งใน N = null (DNF average)', () => {
    assert.equal(averageOfN([null, null, 1, 2, 3], 5), null);
  });

  it('DNF ครั้งที่สองอยู่นอกหน้าต่าง N ไม่ทำให้เป็น null', () => {
    assert.equal(averageOfN([null, 1, 2, 3, 4, null], 5), 3);
  });

  it('ยังไม่ครบ N ครั้ง = null ไม่ใช่เฉลี่ยเท่าที่มี', () => {
    assert.equal(averageOfN(seconds(4), 5), null);
    assert.equal(averageOfN(seconds(11), 12), null);
    assert.equal(averageOfN(seconds(99), 100), null);
    assert.equal(averageOfN([], 5), null);
  });

  it('ครบ N พอดี = คำนวณได้', () => {
    assert.equal(averageOfN(seconds(12), 12), 6.5);
    assert.equal(averageOfN(seconds(100), 100), 50.5);
  });

  it('เวลาเท่ากันหมด = ได้ค่าเดิม ไม่เพี้ยนเพราะการตัด', () => {
    assert.equal(averageOfN([8.5, 8.5, 8.5, 8.5, 8.5], 5), 8.5);
  });

  it('ปัดผลลัพธ์เป็นทศนิยม 2 ตำแหน่ง', () => {
    // ตัด 9.00 กับ 12.00 เหลือ 10.01, 10.02, 11.00 → 10.343333...
    assert.equal(averageOfN([9.0, 10.01, 10.02, 11.0, 12.0], 5), 10.34);
  });

  it('N ต่ำกว่า 3 ตัดไม่ได้ → โยน error แทนที่จะคืนเลขมั่ว', () => {
    assert.throws(() => averageOfN(seconds(5), 2));
  });
});

describe('winStreaks', () => {
  const o = (...list: MatchOutcomeForUser[]) => list;

  it('current นับย้อนจากแมตช์ล่าสุด', () => {
    assert.deepEqual(winStreaks(o('win', 'win', 'win', 'loss', 'win')), { current: 3, best: 3 });
  });

  it('แมตช์ล่าสุดไม่ชนะ → current = 0 แต่ best ยังอยู่', () => {
    assert.deepEqual(winStreaks(o('loss', 'win', 'win', 'win', 'win')), { current: 0, best: 4 });
  });

  it('เสมอทำให้สตรีคขาดเหมือนแพ้', () => {
    assert.deepEqual(winStreaks(o('win', 'draw', 'win', 'win')), { current: 1, best: 2 });
  });

  it('ชนะรวดทั้งประวัติ → current = best', () => {
    assert.deepEqual(winStreaks(o('win', 'win', 'win')), { current: 3, best: 3 });
  });

  it('ไม่เคยชนะเลย / ไม่มีประวัติ = 0 ทั้งคู่', () => {
    assert.deepEqual(winStreaks(o('loss', 'draw')), { current: 0, best: 0 });
    assert.deepEqual(winStreaks([]), { current: 0, best: 0 });
  });
});

describe('winRateOf', () => {
  it('หารด้วยผลรวมของ ชนะ+แพ้+เสมอ แล้วปัด 4 ตำแหน่ง', () => {
    assert.equal(winRateOf(71, 63, 4), 0.5145);
  });

  it('ยังไม่เคยแข่ง = 0 ไม่ใช่ NaN', () => {
    assert.equal(winRateOf(0, 0, 0), 0);
  });
});
