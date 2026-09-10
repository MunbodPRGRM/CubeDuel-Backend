/**
 * unit test ของขอบสัปดาห์ — `docs/api-contract.md` ข้อ 5 (เฟส 7 ก้อนที่ 2)
 *
 * เคสที่พลาดกันบ่อยคือ "จันทร์ 00:00 **เวลาไทย**" ไม่ใช่ 00:00 UTC —
 * ขอบจริงในฐานข้อมูลคือ **อาทิตย์ 17:00 UTC** ทุกครั้ง
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { THAI_UTC_OFFSET_MS, weekKeyOf, weekRangeOf } from './week.js';

/** ช่วยอ่านเทสให้ตรงกับที่คนไทยเห็นบนนาฬิกา — คืนเวลา UTC ที่ตรงกับเวลาไทยที่ระบุ */
function thai(iso: string): Date {
  return new Date(new Date(`${iso}Z`).getTime() - THAI_UTC_OFFSET_MS);
}

describe('weekRangeOf', () => {
  it('ขอบสัปดาห์คือจันทร์ 00:00 ไทย = อาทิตย์ 17:00 UTC', () => {
    // 2026-09-10 เป็นวันพฤหัสบดี → จันทร์ของสัปดาห์นั้นคือ 2026-09-07
    const { start, end } = weekRangeOf(thai('2026-09-10T13:45:00'));

    assert.equal(start.toISOString(), '2026-09-06T17:00:00.000Z');
    assert.equal(end.toISOString(), '2026-09-13T17:00:00.000Z');
  });

  it('ช่วงยาว 7 วันพอดีเสมอ', () => {
    const { start, end } = weekRangeOf(thai('2026-09-10T13:45:00'));
    assert.equal(end.getTime() - start.getTime(), 7 * 24 * 60 * 60 * 1000);
  });

  it('จันทร์ 00:00 ไทย เป๊ะ ๆ นับเป็นสัปดาห์ใหม่ (ขอบซ้ายรวม)', () => {
    const { start } = weekRangeOf(thai('2026-09-07T00:00:00.000'));
    assert.equal(start.toISOString(), '2026-09-06T17:00:00.000Z');
  });

  it('ก่อนจันทร์ 00:00 ไทย 1 มิลลิวินาที ยังเป็นสัปดาห์เก่า', () => {
    const { start, end } = weekRangeOf(new Date(thai('2026-09-07T00:00:00.000').getTime() - 1));
    assert.equal(start.toISOString(), '2026-08-30T17:00:00.000Z');
    assert.equal(end.toISOString(), '2026-09-06T17:00:00.000Z');
  });

  it('อาทิตย์ 23:59 ไทย ยังอยู่สัปดาห์เดิม ไม่ใช่สัปดาห์ถัดไป', () => {
    const { start } = weekRangeOf(thai('2026-09-13T23:59:59.999'));
    assert.equal(start.toISOString(), '2026-09-06T17:00:00.000Z');
  });

  it('เวลาไทยหลังเที่ยงคืนของวันจันทร์ แต่ยังเป็น "วันอาทิตย์" ในเวลา UTC', () => {
    // 2026-09-07T01:00 ไทย = 2026-09-06T18:00Z — ถ้าเผลอคิดด้วยวัน UTC จะได้สัปดาห์ก่อนหน้า
    const { start } = weekRangeOf(thai('2026-09-07T01:00:00'));
    assert.equal(start.toISOString(), '2026-09-06T17:00:00.000Z');
  });

  it('เวลาไทยก่อนเที่ยงคืนของวันอาทิตย์ แต่ข้ามเป็น "วันจันทร์" ในเวลา UTC แล้ว', () => {
    // 2026-09-13T23:00 ไทย = 2026-09-13T16:00Z (ยังอาทิตย์ UTC) — เช็คอีกฝั่งของขอบ
    const { end } = weekRangeOf(thai('2026-09-13T16:59:59.999'));
    assert.equal(end.toISOString(), '2026-09-13T17:00:00.000Z');
  });

  it('ข้ามปีได้ถูกต้อง', () => {
    // 2027-01-01 เป็นวันศุกร์ → จันทร์ของสัปดาห์นั้นคือ 2026-12-28
    const { start, end } = weekRangeOf(thai('2027-01-01T09:00:00'));
    assert.equal(start.toISOString(), '2026-12-27T17:00:00.000Z');
    assert.equal(end.toISOString(), '2027-01-03T17:00:00.000Z');
  });

  it('ทุกวันในสัปดาห์เดียวกันได้ช่วงเดียวกัน', () => {
    const days = [7, 8, 9, 10, 11, 12, 13].map((d) =>
      weekRangeOf(thai(`2026-09-${String(d).padStart(2, '0')}T12:00:00`)),
    );
    for (const range of days) {
      assert.equal(range.start.toISOString(), days[0]!.start.toISOString());
    }
  });
});

describe('weekKeyOf', () => {
  it('คืนวันที่ของวันจันทร์ตามปฏิทินไทย ไม่ใช่ของ UTC', () => {
    // ขอบเป็น 2026-09-06T17:00Z แต่คนไทยเรียกสัปดาห์นี้ว่าสัปดาห์ของวันที่ 7
    assert.equal(weekKeyOf(weekRangeOf(thai('2026-09-10T13:45:00'))), '2026-09-07');
  });

  it('สัปดาห์ติดกันได้คีย์คนละตัว', () => {
    const a = weekKeyOf(weekRangeOf(thai('2026-09-13T23:59:59.999')));
    const b = weekKeyOf(weekRangeOf(thai('2026-09-14T00:00:00.000')));
    assert.equal(a, '2026-09-07');
    assert.equal(b, '2026-09-14');
  });
});
