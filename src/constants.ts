/** ค่าคงที่ของฝั่ง server — ที่มา: docs/game-rules.md, docs/api-contract.md */
import { CubeType } from '@prisma/client';

export const ELO_K_FACTOR = 32;
export const ELO_INITIAL_RATING = 1000;

export const COUNTDOWN_MS = 3_000;
export const INSPECTION_MS = 15_000;
export const FINAL_COUNTDOWN_MS = 10_000;

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
