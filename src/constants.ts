/** ค่าคงที่ของฝั่ง server — ที่มา: docs/game-rules.md, docs/api-contract.md */
import { CubeType } from '@prisma/client';
import type { ApiCubeType } from './types/cube.js';

export const ELO_K_FACTOR = 32;
export const ELO_INITIAL_RATING = 1000;

export const COUNTDOWN_MS = 3_000;
export const INSPECTION_MS = 15_000;
export const FINAL_COUNTDOWN_MS = 10_000;

/** รอ `solve:ready` ครบทุกคนได้นานสุดเท่านี้ แล้วไปต่อเอง (game-rules.md ข้อ 1) */
export const LOADING_TIMEOUT_MS = 15_000;

/** เจอคู่แล้วหน่วงให้ดูข้อมูลคู่แข่งเท่านี้ก่อนเข้า LOADING เอง (game-rules.md ข้อ 1) */
export const MATCHED_DELAY_MS = 2_000;

/** ความถี่ที่กวาดคิวจับคู่ (ADR-039 ข้อ 7) */
export const QUEUE_TICK_MS = 1_000;

/** ความถี่ที่ส่ง `queue:status` ให้คนที่รออยู่ (socket-events.md ข้อ 4) */
export const QUEUE_STATUS_INTERVAL_MS = 5_000;

/** รอคิวเกินเท่านี้ = ยกเลิกคิว แจ้ง `queue:timeout` (game-rules.md ข้อ 8) */
export const QUEUE_TIMEOUT_MS = 180_000;

/**
 * ขนาดของห้องผู้เล่นหลายคน (game-rules.md ข้อ 8 + 9)
 *   - ครบ `MULTIPLAYER_ROOM_MAX` คนในคิว = จับกลุ่มทันที
 *   - รอเกิน `MULTIPLAYER_SHORT_GROUP_AFTER_MS` แล้วมีอย่างน้อย `MULTIPLAYER_ROOM_MIN` คน = เริ่มด้วยเท่าที่มี
 *   - เหลือต่ำกว่า `MULTIPLAYER_ROOM_MIN` ก่อนจับเวลา = ห้องล่ม (ADR-041 ข้อ 3)
 * ตัวเลขชุดนี้ผูกกับ CHECK `player_count IN (3, 4)` ของตาราง `MultiplayerMatch` ด้วย
 */
export const MULTIPLAYER_ROOM_MIN = 3;
export const MULTIPLAYER_ROOM_MAX = 4;
export const MULTIPLAYER_SHORT_GROUP_AFTER_MS = 60_000;

/** หลุดการเชื่อมต่อแล้วมีเวลากลับมาเท่านี้ (game-rules.md ข้อ 6) */
export const DISCONNECT_GRACE_MS = 30_000;

/** ความถี่ของ `opponent:progress` (socket-events.md ข้อ 7 — ต้อง throttle จริง) */
export const PROGRESS_INTERVAL_MS = 500;

/** ชดเชย latency ได้ไม่เกินเท่านี้ กัน client ปลอม RTT สูงเพื่อลดเวลาตัวเอง (game-rules.md ข้อ 3) */
export const MAX_LATENCY_COMPENSATION_MS = 150;

/**
 * ไม่มีใครแก้เสร็จเลย ห้องจะจบเองเมื่อครบเวลานี้นับจากเริ่ม SOLVING แล้วทุกคนได้ DNF
 * (game-rules.md ข้อ 4 — กันห้องค้างถาวรเพราะมีคนเปิดทิ้งไว้)
 */
export const HARD_TIMEOUT_MS: Record<ApiCubeType, number> = {
  '2x2x2': 5 * 60_000,
  '3x3x3': 10 * 60_000,
  pyraminx: 5 * 60_000,
  pyramorphix: 5 * 60_000,
};

/**
 * ทุกประเภทรูบิค — ใช้ตอนสมัครสมาชิกเพื่อสร้างแถว Rating ให้ครบ 4 แถว
 * (database-schema.md ตารางที่ 6: ผู้ใช้ 1 คน = Rating 4 แถวเสมอ)
 */
export const ALL_CUBE_TYPES: CubeType[] = [
  CubeType.CUBE_2X2X2,
  CubeType.CUBE_3X3X3,
  CubeType.PYRAMINX,
  CubeType.PYRAMORPHIX,
];

/** cost ของ bcrypt — ยิ่งสูงยิ่งช้าและยิ่งทนการเดารหัสผ่าน */
export const BCRYPT_ROUNDS = 12;

/** เพดานของ bcrypt: ตัดข้อความส่วนที่เกิน 72 ไบต์ทิ้ง → ต้องกันไว้ตั้งแต่ชั้น validation */
export const PASSWORD_MAX_BYTES = 72;

/** ชื่อ cookie ที่เก็บ refresh token บนเว็บ (Capacitor ใช้ secure storage แทน) */
export const REFRESH_COOKIE_NAME = 'cubeduel_refresh';

/** path ของ cookie — ส่งเฉพาะตอนเรียก endpoint กลุ่ม auth เท่านั้น */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
