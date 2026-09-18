/**
 * unit test ของป้ายกิจกรรมในรายชื่อคนออนไลน์ — ADR-086 ข้อ 3 (เฟส 13 ก้อนที่ 24)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveActivity } from './activity.js';
import { ACTIVE_STATES, type RoomState } from './types.js';

const NOT_ACTIVE: RoomState[] = ['WAITING', 'FINISHED', 'ABORTED'];

describe('resolveActivity', () => {
  it('ไม่อยู่ทั้งคิวและห้อง → idle ไม่มีประเภท', () => {
    assert.deepEqual(resolveActivity(null, null), { activity: 'idle', cubeType: null });
  });

  it('อยู่ในคิว → queue + ประเภทที่รอ', () => {
    assert.deepEqual(resolveActivity(null, 'pyraminx'), {
      activity: 'queue',
      cubeType: 'pyraminx',
    });
  });

  it('ผู้เล่นในห้องที่อยู่ใน ACTIVE_STATES → playing', () => {
    for (const roomState of ACTIVE_STATES) {
      assert.deepEqual(
        resolveActivity({ seat: 'player', roomState, cubeType: '3x3x3' }, null),
        { activity: 'playing', cubeType: '3x3x3' },
        roomState,
      );
    }
  });

  it('ผู้เล่นในห้องที่รอเริ่ม / จบแล้ว → in_room (ไม่ใช่ playing)', () => {
    for (const roomState of NOT_ACTIVE) {
      assert.deepEqual(
        resolveActivity({ seat: 'player', roomState, cubeType: '2x2x2' }, null),
        { activity: 'in_room', cubeType: '2x2x2' },
        roomState,
      );
    }
  });

  it('ผู้ชม → spectating ไม่ว่าห้องอยู่สถานะไหน', () => {
    for (const roomState of [...ACTIVE_STATES, ...NOT_ACTIVE]) {
      assert.deepEqual(
        resolveActivity({ seat: 'spectator', roomState, cubeType: 'pyramorphix' }, null),
        { activity: 'spectating', cubeType: 'pyramorphix' },
      );
    }
  });

  it('ห้องมาก่อนคิวถ้าซ้อนกัน', () => {
    assert.deepEqual(
      resolveActivity({ seat: 'player', roomState: 'WAITING', cubeType: '3x3x3' }, '2x2x2'),
      { activity: 'in_room', cubeType: '3x3x3' },
    );
  });
});
