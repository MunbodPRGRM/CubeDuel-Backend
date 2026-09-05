/**
 * Move ที่ผู้เล่นส่งเข้ามาได้ แยกตามประเภทรูบิค
 *
 * ที่มา: docs/game-rules.md ข้อ 11 "Move ที่ผู้เล่นส่งได้" + ADR-018
 *   - รับเฉพาะ **การหมุนหน้า/ชั้น** เท่านั้น
 *   - ห้าม move หมุนทั้งลูก (`x` `y` `z` ของ 3x3x3, `uv` `rv` `lv` `bv` ของ Pyraminx)
 *     เพราะถ้ามี move พวกนี้ สถานะ "แก้เสร็จ" จะมีได้หลายแบบ ตรวจด้วย
 *     `isIdentical(defaultPattern())` ไม่ได้
 *
 * ⚠️ ไฟล์นี้ต้องตรงกับ `frontend/src/cube/moves.ts` เป๊ะ — ไม่มีอะไรเตือนถ้าลืม (ADR-021)
 */
import type { CubeType } from '../types/cube.js';

/** ต่อท้าย move ได้: ไม่ใส่ = ตามเข็ม 90°, `'` = ทวนเข็ม, `2` = 180° */
const QUARTER_SUFFIXES = ['', "'", '2'] as const;
/** พีระมิดหมุนได้แค่ 3 ทาง — `X2` ซ้ำกับ `X'` จึงไม่รับ เพื่อให้ move stream มีรูปแบบเดียว */
const THIRD_SUFFIXES = ['', "'"] as const;

function expand(bases: readonly string[], suffixes: readonly string[]): string[] {
  return bases.flatMap((base) => suffixes.map((suffix) => base + suffix));
}

const CUBE_FACES = ['U', 'D', 'L', 'R', 'F', 'B'] as const;
/** 3x3x3 หมุนสองชั้นพร้อมกัน — cubing.js รับทั้ง `Uw` และ `u` */
const CUBE3_WIDE = ['Uw', 'Dw', 'Lw', 'Rw', 'Fw', 'Bw', 'u', 'd', 'l', 'r', 'f', 'b'] as const;
const CUBE3_SLICES = ['M', 'E', 'S'] as const;
/** Pyraminx: ตัวใหญ่ = หมุนสองชั้น, ตัวเล็ก = หมุนเฉพาะยอด (tip) */
const PYRAMINX_LAYERS = ['U', 'L', 'R', 'B'] as const;
const PYRAMINX_TIPS = ['u', 'l', 'r', 'b'] as const;

/** รายการ move ที่ยอมรับของแต่ละประเภท */
export const ALLOWED_MOVES: Record<CubeType, readonly string[]> = {
  '2x2x2': expand(CUBE_FACES, QUARTER_SUFFIXES),
  '3x3x3': [
    ...expand(CUBE_FACES, QUARTER_SUFFIXES),
    ...expand(CUBE3_WIDE, QUARTER_SUFFIXES),
    ...expand(CUBE3_SLICES, QUARTER_SUFFIXES),
  ],
  pyraminx: [...expand(PYRAMINX_LAYERS, THIRD_SUFFIXES), ...expand(PYRAMINX_TIPS, THIRD_SUFFIXES)],
  // Pyramorphix ใช้ notation ของ 2x2x2 ทั้งหมด (ADR-019)
  pyramorphix: expand(CUBE_FACES, QUARTER_SUFFIXES),
};

const ALLOWED_SETS: Record<CubeType, ReadonlySet<string>> = {
  '2x2x2': new Set(ALLOWED_MOVES['2x2x2']),
  '3x3x3': new Set(ALLOWED_MOVES['3x3x3']),
  pyraminx: new Set(ALLOWED_MOVES.pyraminx),
  pyramorphix: new Set(ALLOWED_MOVES.pyramorphix),
};

export function isAllowedMove(cubeType: CubeType, move: string): boolean {
  return ALLOWED_SETS[cubeType].has(move);
}

/** ชื่อหน้า/ชั้นของ move (ตัด `'` กับ `2` ออก) — ใช้ดูว่า move สองตัวหมุนชั้นเดียวกันไหม */
export function moveFamily(move: string): string {
  return move.replace(/['2]+$/, '');
}
