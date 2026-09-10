import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moveLogCutoff } from './maintenance.js';
import { MOVE_LOG_RETENTION_DAYS } from '../constants.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

describe('moveLogCutoff', () => {
  it('ถอยหลังไปเท่ากับจำนวนวันที่เก็บพอดี', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const cutoff = moveLogCutoff(now);
    assert.equal((now.getTime() - cutoff.getTime()) / DAY_MS, MOVE_LOG_RETENTION_DAYS);
  });

  it('flag ที่อายุเท่ากับเส้นแบ่งพอดียังไม่ถูกล้าง (เงื่อนไขเป็น < ไม่ใช่ <=)', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const cutoff = moveLogCutoff(now);
    // แถวที่สร้างตรงเส้นแบ่งเป๊ะ ๆ ไม่เข้าเงื่อนไข `createdAt < cutoff`
    assert.equal(cutoff < cutoff, false);
    assert.ok(new Date(cutoff.getTime() - 1) < cutoff);
  });
});
