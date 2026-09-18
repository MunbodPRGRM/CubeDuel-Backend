/**
 * unit test ของตัวรวบ `presence:count` — ADR-086 ข้อ 2 (เฟส 13 ก้อนที่ 24)
 *
 * สิ่งที่ต้องไม่พัง: ขอกี่ครั้งในช่วงเดียวกันก็ส่งครั้งเดียว · ค่าเท่าเดิมไม่ส่ง (รีเฟรชหน้าต้องไม่มี event)
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createThrottledBroadcaster } from './presence.js';

const INTERVAL = 5_000;

describe('createThrottledBroadcaster', () => {
  let value: number;
  let sent: number[];
  let broadcaster: ReturnType<typeof createThrottledBroadcaster>;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    value = 10;
    sent = [];
    broadcaster = createThrottledBroadcaster(
      INTERVAL,
      () => value,
      (v) => sent.push(v),
    );
  });

  afterEach(() => {
    broadcaster.reset();
    mock.timers.reset();
  });

  it('ส่งตอนท้ายช่วง ไม่ใช่ทันที', () => {
    broadcaster.schedule();
    mock.timers.tick(INTERVAL - 1);
    assert.deepEqual(sent, []);
    mock.timers.tick(1);
    assert.deepEqual(sent, [10]);
  });

  it('ขอหลายครั้งในช่วงเดียวกัน = ส่งครั้งเดียว ด้วยค่าล่าสุด', () => {
    broadcaster.schedule();
    value = 11;
    broadcaster.schedule();
    value = 12;
    broadcaster.schedule();
    mock.timers.tick(INTERVAL);
    assert.deepEqual(sent, [12]);
  });

  it('ค่าเท่ากับที่ส่งครั้งล่าสุด → ไม่ส่ง (หลุดแล้วต่อใหม่ภายในช่วง)', () => {
    broadcaster.schedule();
    mock.timers.tick(INTERVAL);
    assert.deepEqual(sent, [10]);

    value = 9; // รีเฟรชหน้า: หลุด −1 …
    broadcaster.schedule();
    value = 10; // … แล้วต่อ +1 ก่อนครบช่วง
    broadcaster.schedule();
    mock.timers.tick(INTERVAL);
    assert.deepEqual(sent, [10]);
  });

  it('ช่วงถัดไปที่ค่าเปลี่ยนจริงยังส่งได้', () => {
    broadcaster.schedule();
    mock.timers.tick(INTERVAL);
    value = 14;
    broadcaster.schedule();
    mock.timers.tick(INTERVAL);
    assert.deepEqual(sent, [10, 14]);
  });

  it('reset() ยกเลิกรอบที่นัดไว้ และลืมค่าล่าสุด', () => {
    broadcaster.schedule();
    broadcaster.reset();
    mock.timers.tick(INTERVAL);
    assert.deepEqual(sent, []);

    broadcaster.schedule();
    mock.timers.tick(INTERVAL);
    assert.deepEqual(sent, [10]);
  });
});
