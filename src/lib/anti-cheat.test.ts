/**
 * unit test ของเกณฑ์ soft — `docs/game-rules.md` ข้อ 10
 * `WIN_STREAK` เพิ่มในเฟส 5 ก้อนที่ 1 (นิยามที่ใช้จริงอยู่ใน ADR-038 ข้อ 4)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkWinStreak,
  inspectSolve,
  WIN_STREAK_LOOKBACK,
  type RatedMatchRow,
} from './anti-cheat.js';

/** move ที่ห่างเท่า ๆ กันจำนวนหนึ่ง — ใช้จำลอง solve ของคนจริง */
function evenTimestamps(count: number, gapMs: number): number[] {
  return Array.from({ length: count }, (_, index) => (index + 1) * gapMs);
}

describe('inspectSolve', () => {
  it('solve ปกติของคน (2x2x2 5 วิ 12 ท่า ~8 TPS) ไม่ถูก flag เลย', () => {
    const flags = inspectSolve({
      cubeType: '2x2x2',
      solveTimeMs: 5_000,
      moveCount: 12,
      moveTimestampsMs: evenTimestamps(12, 125),
    });
    assert.deepEqual(flags, []);
  });

  it('เร็วเกินกว่าที่มนุษย์ทำได้ → IMPOSSIBLE_TIME', () => {
    const flags = inspectSolve({
      cubeType: '3x3x3',
      solveTimeMs: 2_140,
      moveCount: 40,
      moveTimestampsMs: evenTimestamps(40, 50),
    });
    assert.equal(flags[0]?.reason, 'IMPOSSIBLE_TIME');
    assert.equal(flags[0]?.detail.measured, 2.14);
    assert.equal(flags[0]?.detail.threshold, 3.5);
  });

  it('move น้อยผิดปกติเป็นเกณฑ์ของ 3x3x3 เท่านั้น', () => {
    const sample = { solveTimeMs: 6_000, moveCount: 11, moveTimestampsMs: evenTimestamps(11, 500) };
    assert.ok(
      inspectSolve({ ...sample, cubeType: '3x3x3' }).some(
        (flag) => flag.reason === 'LOW_MOVE_COUNT',
      ),
    );
    assert.deepEqual(inspectSolve({ ...sample, cubeType: '2x2x2' }), []);
  });

  it('หมุนรัวเกิน 15 TPS ต่อเนื่อง → HIGH_TPS + MOVE_GAP', () => {
    const flags = inspectSolve({
      cubeType: '3x3x3',
      solveTimeMs: 20_000,
      moveCount: 30,
      moveTimestampsMs: evenTimestamps(30, 10),
    });
    const reasons = flags.map((flag) => flag.reason);
    assert.ok(reasons.includes('HIGH_TPS'));
    assert.ok(reasons.includes('MOVE_GAP'));
  });
});

describe('checkWinStreak', () => {
  const ME = 7;

  /** แมตช์ที่ฉันชนะคนที่ Elo ต่างกัน `gap` แต้ม */
  const win = (matchId: number, gap = 400): RatedMatchRow => ({
    matchId,
    winnerId: ME,
    selfEloBefore: 1600,
    opponentEloBefore: 1600 - gap,
  });

  const streak = (count: number, gap = 400): RatedMatchRow[] =>
    Array.from({ length: count }, (_, index) => win(1_000 - index, gap));

  it('ชนะติดกัน 21 แมตช์แบบห่างชั้น → ถูก flag', () => {
    const flag = checkWinStreak(ME, streak(WIN_STREAK_LOOKBACK), '2x2x2');
    assert.equal(flag?.reason, 'WIN_STREAK');
    assert.equal(flag?.detail.measured, 21);
    assert.equal(flag?.detail.threshold, 20);
    assert.equal(flag?.detail.cubeType, '2x2x2');
  });

  it('ชนะติดกัน 20 แมตช์ยังไม่ถึงเกณฑ์ ("เกิน 20" ไม่ใช่ "ตั้งแต่ 20")', () => {
    assert.equal(checkWinStreak(ME, streak(20), '2x2x2'), null);
  });

  it('แพ้คั่นกลางทำให้สตรีคขาด', () => {
    const rows = streak(WIN_STREAK_LOOKBACK);
    rows[5] = { ...rows[5]!, winnerId: 99 };
    assert.equal(checkWinStreak(ME, rows, '3x3x3'), null);
  });

  it('เสมอ (winner_id = NULL) ก็ทำให้สตรีคขาด', () => {
    const rows = streak(WIN_STREAK_LOOKBACK);
    rows[0] = { ...rows[0]!, winnerId: null };
    assert.equal(checkWinStreak(ME, rows, '3x3x3'), null);
  });

  it('ชนะคนที่ฝีมือใกล้เคียงไม่นับเข้าสตรีค (Elo ต้องต่างเกิน 300)', () => {
    assert.equal(checkWinStreak(ME, streak(WIN_STREAK_LOOKBACK, 300), 'pyraminx'), null);
    assert.ok(checkWinStreak(ME, streak(WIN_STREAK_LOOKBACK, 301), 'pyraminx') !== null);
  });

  it('ต่างกันเกิน 300 ในทางที่ตัวเองเป็นฝ่ายเสียเปรียบก็เข้าเกณฑ์ (ชนะรวดทั้งที่คะแนนต่ำกว่ามาก)', () => {
    const rows = streak(WIN_STREAK_LOOKBACK).map((row) => ({
      ...row,
      selfEloBefore: 1000,
      opponentEloBefore: 1600,
    }));
    assert.equal(checkWinStreak(ME, rows, '2x2x2')?.detail.measured, 21);
  });

  it('แมตช์ที่ไม่มีข้อมูล Elo (ไม่ควรหลุดเข้ามา) ตัดสตรีคทิ้ง ไม่ใช่เดาแทน', () => {
    const rows = streak(WIN_STREAK_LOOKBACK);
    rows[3] = { ...rows[3]!, opponentEloBefore: null };
    assert.equal(checkWinStreak(ME, rows, '2x2x2'), null);
  });

  it('อ่านมาเกิน lookback ก็ไม่ทำให้ตัวเลขที่รายงานเฟ้อ', () => {
    const flag = checkWinStreak(ME, streak(60), '2x2x2');
    assert.equal(flag?.detail.measured, WIN_STREAK_LOOKBACK);
  });

  it('ไม่มีประวัติเลย → ไม่ flag', () => {
    assert.equal(checkWinStreak(ME, [], '2x2x2'), null);
  });
});
