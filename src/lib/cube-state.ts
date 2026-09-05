/**
 * สถานะคิวบ์ฝั่ง server — โหลด KPuzzle ของแต่ละประเภทและตรวจว่า "แก้เสร็จ" หรือยัง
 *
 * ที่มา: docs/game-rules.md ข้อ 11, ADR-018 (ห้าม move หมุนทั้งลูก → สถานะแก้เสร็จมีแบบเดียว)
 * และ ADR-019 (Pyramorphix ยืม KPuzzle ของ 2x2x2 แต่ตรวจแก้เสร็จคนละกติกา)
 */
import { Alg } from 'cubing/alg';
import type { KPattern, KPuzzle } from 'cubing/kpuzzle';
import { puzzles } from 'cubing/puzzles';
import type { CubeType } from '../types/cube.js';
import { isAllowedMove } from './moves.js';

/** ประเภทรูบิค → puzzle ของ cubing.js ที่ใช้เป็นตรรกะ (Pyramorphix ใช้ของ 2x2x2 — ADR-019) */
const PUZZLE_ID: Record<CubeType, string> = {
  '2x2x2': '2x2x2',
  '3x3x3': '3x3x3',
  pyraminx: 'pyraminx',
  pyramorphix: '2x2x2',
};

const kpuzzleCache = new Map<string, Promise<KPuzzle>>();

/** โหลด KPuzzle (แพงพอควร) แล้วเก็บไว้ใช้ซ้ำตลอดอายุ process */
export function getKPuzzle(cubeType: CubeType): Promise<KPuzzle> {
  const id = PUZZLE_ID[cubeType];
  let cached = kpuzzleCache.get(id);
  if (!cached) {
    cached = puzzles[id].kpuzzle();
    kpuzzleCache.set(id, cached);
  }
  return cached;
}

// ---------------------------------------------------------------- Pyramorphix

const CORNERS_ORBIT = 'CORNERS';

function movedSlots(kpuzzle: KPuzzle, move: string): Set<number> {
  const pieces = kpuzzle.defaultPattern().applyMove(move).patternData[CORNERS_ORBIT]!.pieces;
  return new Set(pieces.map((_, slot) => slot).filter((slot) => pieces[slot] !== slot));
}

/**
 * ชิ้นไหนเป็น "ยอดพีระมิด" ของ Pyramorphix (เห็น 3 หน้า จึงต้องตรวจทิศทางด้วย)
 *
 * ⚠️ ห้าม hard-code `[0, 2, 5, 7]` — ลำดับ index ของ cubing.js ไม่ตรงกับที่คนทั่วไปคิด
 * และอาจเปลี่ยนเมื่ออัปเดตเวอร์ชัน (ADR-019) จึงคำนวณใหม่จากตัว KPuzzle ทุกครั้ง:
 * ดูว่าแต่ละช่องอยู่ octant ไหนของลูกบาศก์ (U = y บวก, R = x บวก, F = z บวก)
 * แล้วยอดพีระมิดคือช่องที่เครื่องหมายทั้งสามคูณกันได้ +1
 */
function deriveApexSlots(kpuzzle: KPuzzle): number[] {
  const yPlus = movedSlots(kpuzzle, 'U');
  const xPlus = movedSlots(kpuzzle, 'R');
  const zPlus = movedSlots(kpuzzle, 'F');
  if (yPlus.size !== 4 || xPlus.size !== 4 || zPlus.size !== 4) {
    throw new Error('KPuzzle ของ 2x2x2 ผิดรูป: U/R/F ต้องขยับชั้นละ 4 ชิ้น');
  }

  const apex: number[] = [];
  for (let slot = 0; slot < 8; slot++) {
    const sx = xPlus.has(slot) ? 1 : -1;
    const sy = yPlus.has(slot) ? 1 : -1;
    const sz = zPlus.has(slot) ? 1 : -1;
    if (sx * sy * sz === 1) apex.push(slot);
  }
  if (apex.length !== 4) throw new Error(`ยอดพีระมิดต้องมี 4 ชิ้น แต่คำนวณได้ ${apex.length}`);
  return apex;
}

let apexSlotsCache: number[] | null = null;

export async function getApexSlots(): Promise<number[]> {
  apexSlotsCache ??= deriveApexSlots(await getKPuzzle('pyramorphix'));
  return apexSlotsCache;
}

/**
 * Pyramorphix แก้เสร็จ = ตำแหน่งถูกครบ 8 ชิ้น AND ทิศทางถูกเฉพาะ 4 ชิ้นที่เป็นยอดพีระมิด
 * (อีก 4 ชิ้นโผล่เป็นสามเหลี่ยมสีเดียว มองไม่ออกว่าหมุนไปทางไหน — ADR-019)
 */
function isPyramorphixSolved(pattern: KPattern, apexSlots: readonly number[]): boolean {
  const orbit = pattern.patternData[CORNERS_ORBIT]!;
  for (let slot = 0; slot < 8; slot++) {
    if (orbit.pieces[slot] !== slot) return false;
    if (apexSlots.includes(slot) && orbit.orientation[slot] !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------- API หลัก

export async function isSolved(cubeType: CubeType, pattern: KPattern): Promise<boolean> {
  if (cubeType === 'pyramorphix') return isPyramorphixSolved(pattern, await getApexSlots());
  const kpuzzle = await getKPuzzle(cubeType);
  return pattern.isIdentical(kpuzzle.defaultPattern());
}

/** สถานะหลังใส่ scramble ให้คิวบ์ที่แก้เสร็จแล้ว */
export async function patternAfterScramble(
  cubeType: CubeType,
  scramble: string,
): Promise<KPattern> {
  const kpuzzle = await getKPuzzle(cubeType);
  return kpuzzle.defaultPattern().applyAlg(new Alg(scramble));
}

/**
 * เดินซ้ำ move ทั้งหมดที่ผู้เล่นส่งมา แล้วบอกว่าคิวบ์ถูกแก้จริงไหม
 * (เฟส 4 ใช้ตรวจ `solve:solved` — anti-cheat แบบ hard ตาม game-rules.md ข้อ 10)
 */
export async function replaySolve(
  cubeType: CubeType,
  scramble: string,
  moves: readonly string[],
): Promise<{ solved: boolean; invalidMove: string | null }> {
  const invalid = moves.find((move) => !isAllowedMove(cubeType, move));
  if (invalid !== undefined) return { solved: false, invalidMove: invalid };

  let pattern = await patternAfterScramble(cubeType, scramble);
  for (const move of moves) pattern = pattern.applyMove(move);
  return { solved: await isSolved(cubeType, pattern), invalidMove: null };
}
