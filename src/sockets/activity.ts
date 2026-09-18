import { queuedCubeTypeOf } from './queue.js';
import { membershipOf } from './room-registry.js';
import { ACTIVE_STATES, type CubeType, type RoomState, type Seat } from './types.js';

/**
 * "ตอนนี้ทำอะไรอยู่" ของสมาชิกที่ออนไลน์ — ป้ายในรายชื่อคนออนไลน์ (ADR-086 ข้อ 3 · api-contract.md ข้อ 3)
 *
 * อ่านจาก memory ล้วน (คิว + ทะเบียนห้อง) ไม่แตะ DB
 * ห้องฝึกซ้อมไม่ใช้ socket (ขอ scramble ผ่าน REST) → คนที่ฝึกอยู่ได้ `idle` — ยอมรับ
 */
export type OnlineActivity = 'playing' | 'spectating' | 'in_room' | 'queue' | 'idle';

/** ลำดับในรายชื่อ — กำลังแข่งขึ้นก่อน ว่างอยู่ท้ายสุด */
export const ACTIVITY_ORDER: readonly OnlineActivity[] = [
  'playing',
  'spectating',
  'in_room',
  'queue',
  'idle',
];

export interface ActivityInfo {
  activity: OnlineActivity;
  /** ประเภทของห้อง/คิว · `idle` = `null` */
  cubeType: CubeType | null;
}

/**
 * ตัดสินจากข้อมูลที่ดึงมาแล้ว — แยกจาก `activityOf()` ให้เทสได้โดยไม่ต้องสร้างห้อง/คิวจริง
 *
 * ห้องมาก่อนคิว: ตามกติกาคนในห้องเข้าคิวไม่ได้อยู่แล้ว แต่ถ้าเกิดซ้อนกันจริง "อยู่ในห้อง" ตรงกับสิ่งที่เห็นบนจอมากกว่า
 * เส้นแบ่ง `playing` / `in_room` ใช้ `ACTIVE_STATES` (ADR-034 ข้อ 4) — ห้องที่ `FINISHED` แล้ว
 * ผู้เล่นยังนั่งดูผลอยู่ต้องไม่ขึ้นว่า "กำลังแข่ง"
 */
export function resolveActivity(
  membership: { seat: Seat; roomState: RoomState; cubeType: CubeType } | null,
  queuedCubeType: CubeType | null,
): ActivityInfo {
  if (membership) {
    const { seat, roomState, cubeType } = membership;
    if (seat === 'spectator') return { activity: 'spectating', cubeType };
    return {
      activity: ACTIVE_STATES.includes(roomState) ? 'playing' : 'in_room',
      cubeType,
    };
  }
  if (queuedCubeType) return { activity: 'queue', cubeType: queuedCubeType };
  return { activity: 'idle', cubeType: null };
}

export function activityOf(userId: number): ActivityInfo {
  const membership = membershipOf(userId);
  return resolveActivity(
    membership
      ? {
          seat: membership.seat,
          roomState: membership.room.state,
          cubeType: membership.room.cubeType,
        }
      : null,
    queuedCubeTypeOf(userId),
  );
}
