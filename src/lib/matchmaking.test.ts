/**
 * unit test ของการเลือกคู่ในคิวจับคู่ — `docs/game-rules.md` ข้อ 8 + ADR-039
 * คุมสามเรื่องที่ผิดแล้วเจ็บ: ช่วง Elo ตามเวลารอ · ใครได้จับก่อน · ห้ามเจอคนเดิมซ้ำติดกัน
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  eloWindowFor,
  groupUp,
  pairUp,
  withinEloWindow,
  type QueueCandidate,
  type QueueWaiter,
} from './matchmaking.js';

const NOW = 1_700_000_000_000;

/** คนในคิวหนึ่งคน — `waitedMs` คือเวลาที่รอมาแล้ว ณ เวลา `NOW` */
function waiting(
  userId: number,
  eloRating: number,
  waitedMs = 0,
  lastOpponentId: number | null = null,
): QueueCandidate {
  return { userId, eloRating, queuedAtTs: NOW - waitedMs, lastOpponentId };
}

describe('eloWindowFor', () => {
  it('ขยายตามเวลารอตามตารางใน game-rules ข้อ 8', () => {
    assert.equal(eloWindowFor(0), 100);
    assert.equal(eloWindowFor(9_999), 100);
    assert.equal(eloWindowFor(10_000), 200);
    assert.equal(eloWindowFor(29_999), 200);
    assert.equal(eloWindowFor(30_000), 350);
    assert.equal(eloWindowFor(59_999), 350);
    assert.equal(eloWindowFor(60_000), 600);
    assert.equal(eloWindowFor(119_999), 600);
  });

  it('เกิน 120 วินาที = ไม่จำกัด (null)', () => {
    assert.equal(eloWindowFor(120_000), null);
    assert.equal(eloWindowFor(500_000), null);
  });
});

describe('withinEloWindow', () => {
  it('เพิ่งเข้าคิวทั้งคู่ = ห่างได้ไม่เกิน 100', () => {
    assert.equal(withinEloWindow(waiting(1, 1_000), waiting(2, 1_100), NOW), true);
    assert.equal(withinEloWindow(waiting(1, 1_000), waiting(2, 1_101), NOW), false);
  });

  it('ใช้ช่วงของฝั่งที่ใจกว้างกว่า (ADR-039 ข้อ 2)', () => {
    const patient = waiting(1, 1_000, 65_000); // ±600
    const fresh = waiting(2, 1_500, 0); // ±100
    assert.equal(withinEloWindow(patient, fresh, NOW), true);
    assert.equal(
      withinEloWindow(fresh, patient, NOW),
      true,
      'ต้องได้ผลเดียวกันไม่ว่าสลับข้างยังไง',
    );
  });

  it('รอเกิน 120 วิ = จับกับใครก็ได้ในคิว', () => {
    const veteran = waiting(1, 800, 130_000);
    assert.equal(withinEloWindow(veteran, waiting(2, 2_400), NOW), true);
  });
});

describe('pairUp', () => {
  it('คิวว่างหรือมีคนเดียว = ไม่จับคู่', () => {
    assert.deepEqual(pairUp([], NOW), []);
    assert.deepEqual(pairUp([waiting(1, 1_000)], NOW), []);
  });

  it('คะแนนใกล้กันจับคู่กันทันที', () => {
    const pairs = pairUp([waiting(1, 1_000), waiting(2, 1_050)], NOW);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0]!.a.userId, pairs[0]!.b.userId].sort(), [1, 2]);
  });

  it('คะแนนห่างเกินช่วงตอนเพิ่งเข้าคิว = ยังไม่จับ', () => {
    assert.deepEqual(pairUp([waiting(1, 1_000), waiting(2, 1_400)], NOW), []);
  });

  it('คู่เดิมที่ห่างกันมาก จับได้เมื่อรอจนช่วงกว้างพอ', () => {
    const entries = [waiting(1, 1_000, 35_000), waiting(2, 1_300, 35_000)];
    assert.equal(pairUp(entries, NOW).length, 1, 'รอ 35 วิ → ±350 ครอบคลุมส่วนต่าง 300');
  });

  it('คนที่รอนานสุดได้เลือกก่อน', () => {
    // 1 รอนานสุด และช่วงของ 1 กว้างพอจะเอา 3 ที่คะแนนห่าง 250 ได้
    const pairs = pairUp([waiting(1, 1_000, 40_000), waiting(2, 1_260), waiting(3, 1_250)], NOW);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.a.userId, 1);
    assert.equal(pairs[0]!.b.userId, 3, 'เลือกคนที่คะแนนใกล้ตัวเองที่สุด');
  });

  it('เลือกคนที่คะแนนใกล้ที่สุดในบรรดาคนที่เข้าเกณฑ์', () => {
    const pairs = pairUp([waiting(1, 1_000), waiting(2, 1_090), waiting(3, 1_010)], NOW);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0]!.a.userId, pairs[0]!.b.userId].sort(), [1, 3]);
  });

  it('คะแนนต่างเท่ากัน → เอาคนที่รอนานกว่า', () => {
    // 1 รอนานสุดจึงได้เลือกก่อน · 2 กับ 3 คะแนนห่างจาก 1 เท่ากัน ต้องได้ 3 ที่รอนานกว่า
    const pairs = pairUp(
      [waiting(1, 1_000, 12_000), waiting(2, 1_050, 3_000), waiting(3, 1_050, 8_000)],
      NOW,
    );
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.a.userId, 1);
    assert.equal(pairs[0]!.b.userId, 3);
  });

  it('สี่คนจับได้สองคู่ในรอบเดียว', () => {
    const pairs = pairUp(
      [waiting(1, 1_000), waiting(2, 1_020), waiting(3, 1_500), waiting(4, 1_520)],
      NOW,
    );
    assert.equal(pairs.length, 2);
    const matched = pairs.flatMap((pair) => [pair.a.userId, pair.b.userId]).sort();
    assert.deepEqual(matched, [1, 2, 3, 4]);
  });

  it('เลี่ยงคู่ล่าสุดถ้ามีตัวเลือกอื่น แม้ตัวเลือกอื่นจะคะแนนห่างกว่า', () => {
    const pairs = pairUp([waiting(1, 1_000, 0, 2), waiting(2, 1_000), waiting(3, 1_080)], NOW);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0]!.a.userId, pairs[0]!.b.userId].sort(), [1, 3]);
  });

  it('เลี่ยงคู่ล่าสุดแม้ฝั่งที่จำไว้จะเป็นอีกคน (จำข้างเดียวก็พอ)', () => {
    const pairs = pairUp([waiting(1, 1_000), waiting(2, 1_000, 0, 1), waiting(3, 1_080)], NOW);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0]!.a.userId, pairs[0]!.b.userId].sort(), [1, 3]);
  });

  it('ไม่มีตัวเลือกอื่น = จับคู่เดิมได้ตามกติกา', () => {
    const pairs = pairUp([waiting(1, 1_000, 0, 2), waiting(2, 1_000, 0, 1)], NOW);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0]!.a.userId, pairs[0]!.b.userId].sort(), [1, 2]);
  });

  it('ผลคงที่ไม่ว่าลำดับในอาร์เรย์จะสลับยังไง', () => {
    const entries = [
      waiting(4, 1_520, 1_000),
      waiting(1, 1_000, 5_000),
      waiting(3, 1_500, 2_000),
      waiting(2, 1_020, 4_000),
    ];
    const first = pairUp(entries, NOW);
    const second = pairUp([...entries].reverse(), NOW);
    const flatten = (pairs: ReturnType<typeof pairUp>) =>
      pairs.map((pair) => [pair.a.userId, pair.b.userId].sort().join('-')).sort();
    assert.deepEqual(flatten(first), flatten(second));
  });

  it('คนที่เหลือเป็นเลขคี่ต้องรอรอบถัดไป ไม่ถูกจับซ้ำซ้อน', () => {
    const pairs = pairUp([waiting(1, 1_000), waiting(2, 1_010), waiting(3, 1_020)], NOW);
    assert.equal(pairs.length, 1);
    const matched = pairs.flatMap((pair) => [pair.a.userId, pair.b.userId]);
    assert.equal(new Set(matched).size, 2);
  });
});

describe('groupUp — จับกลุ่มห้องผู้เล่นหลายคน (game-rules.md ข้อ 8)', () => {
  /** คนในคิวหลายคนหนึ่งคน — สนใจแค่ว่าเข้าคิวมาแล้วกี่มิลลิวินาที */
  function w(userId: number, waitedMs = 0): QueueWaiter {
    return { userId, queuedAtTs: NOW - waitedMs };
  }
  const ids = (groups: QueueWaiter[][]) => groups.map((group) => group.map((x) => x.userId));

  it('ยังไม่ถึง 3 คน = ไม่จับกลุ่ม ไม่ว่าจะรอนานแค่ไหน', () => {
    assert.deepEqual(groupUp([w(1, 300_000), w(2, 300_000)], NOW), []);
  });

  it('ครบ 4 คนจับทันที ไม่ต้องรอ', () => {
    assert.deepEqual(ids(groupUp([w(1), w(2), w(3), w(4)], NOW)), [[1, 2, 3, 4]]);
  });

  it('มี 3 คนแต่ยังรอไม่ถึง 60 วินาที = ยังไม่จับ (รอคนที่ 4 ก่อน)', () => {
    assert.deepEqual(groupUp([w(1, 59_999), w(2, 30_000), w(3, 0)], NOW), []);
  });

  it('คนหัวคิวรอครบ 60 วินาทีแล้วมี 3 คน = เริ่มด้วย 3 คน', () => {
    assert.deepEqual(ids(groupUp([w(1, 60_000), w(2, 30_000), w(3, 0)], NOW)), [[1, 2, 3]]);
  });

  it('นับ 60 วินาทีจากคนที่รอนานที่สุด ไม่ใช่คนที่เพิ่งเข้ามา', () => {
    // คนที่ 1 รอครบแล้ว ที่เหลือเพิ่งเข้า — ยังต้องได้กลุ่ม
    assert.equal(groupUp([w(1, 120_000), w(2, 1_000), w(3, 500)], NOW).length, 1);
    // ไม่มีใครรอครบเลย — ยังไม่ได้กลุ่ม
    assert.equal(groupUp([w(1, 10_000), w(2, 1_000), w(3, 500)], NOW).length, 0);
  });

  it('เรียงตามลำดับเข้าคิว — คนที่รอนานกว่าได้เข้ากลุ่มก่อนเสมอ', () => {
    const groups = groupUp([w(4, 1_000), w(1, 90_000), w(3, 5_000), w(2, 20_000)], NOW);
    assert.deepEqual(ids(groups), [[1, 2, 3, 4]]);
  });

  it('มี 6 คน = ได้ห้อง 4 คนหนึ่งห้อง อีก 2 คนรอต่อ (ครบ 4 เริ่มทันทีมาก่อน — ADR-043 ข้อ 2)', () => {
    const groups = groupUp([w(1, 90_000), w(2, 80_000), w(3, 70_000), w(4, 60_000), w(5), w(6)], NOW);
    assert.deepEqual(ids(groups), [[1, 2, 3, 4]]);
  });

  it('มี 7 คนที่รอครบ 60 วิ = ได้ห้อง 4 คนแล้วตามด้วยห้อง 3 คน', () => {
    const entries = [1, 2, 3, 4, 5, 6, 7].map((id) => w(id, 90_000 - id * 1_000));
    assert.deepEqual(ids(groupUp(entries, NOW)), [
      [1, 2, 3, 4],
      [5, 6, 7],
    ]);
  });

  it('มี 8 คน = ได้สองห้องเต็มโดยไม่ต้องรอ', () => {
    const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => w(id, 8_000 - id));
    assert.deepEqual(ids(groupUp(entries, NOW)), [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it('เข้าคิวพร้อมกันเป๊ะ = ตัดสินด้วย userId ให้ผลคงที่ทุกครั้ง', () => {
    const entries = [w(9), w(2), w(7), w(4)];
    assert.deepEqual(ids(groupUp(entries, NOW)), [[2, 4, 7, 9]]);
    assert.deepEqual(ids(groupUp([...entries].reverse(), NOW)), [[2, 4, 7, 9]]);
  });

  it('ไม่มีใครถูกจับซ้ำสองกลุ่ม', () => {
    const entries = [1, 2, 3, 4, 5, 6, 7].map((id) => w(id, 90_000 - id * 1_000));
    const picked = groupUp(entries, NOW).flat().map((x) => x.userId);
    assert.equal(new Set(picked).size, picked.length);
  });
});
