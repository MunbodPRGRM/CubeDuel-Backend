/**
 * สร้าง scramble ฝั่ง server (docs/api-contract.md ข้อ 6 + game-rules.md ข้อ 11)
 *
 * 📕 **server เป็นคน generate เท่านั้น** ห้ามให้ client generate เอง
 * ไม่งั้นผู้เล่นเลือก scramble ที่ง่ายให้ตัวเองได้
 */
import { randomScrambleForEvent } from 'cubing/scramble';
import { setSearchDebug } from 'cubing/search';
import type { CubeType } from '../types/cube.js';
import { moveFamily } from '../lib/moves.js';
import { isSolved, patternAfterScramble } from '../lib/cube-state.js';

// cubing.js พิมพ์เวลาที่ใช้ generate ลง console ทุกครั้ง — ปิดไว้ ไม่งั้น log ของ server รก
setSearchDebug({ logPerf: false });

/** ประเภทรูบิค → event ของ WCA ที่ใช้ generate (Pyramorphix ใช้ของ 2x2x2 — ADR-019) */
const SCRAMBLE_EVENT: Record<CubeType, string> = {
  '2x2x2': '222',
  '3x3x3': '333',
  pyraminx: 'pyram',
  pyramorphix: '222',
};

/** จำนวน scramble สูงสุดต่อหนึ่งคำขอ (api-contract.md ข้อ 6) */
export const MAX_SCRAMBLE_COUNT = 12;

/** กัน generate วนไม่จบถ้า scramble ไม่ผ่านการตรวจซ้ำ ๆ (ในทางปฏิบัติแทบไม่เคยเกิน 1 รอบ) */
const MAX_ATTEMPTS = 10;

/** มี move ติดกันที่หักล้างกันเองไหม เช่น `R R'` หรือ `U2 U2` (game-rules.md ข้อ 11) */
function hasAdjacentSameLayer(scramble: string): boolean {
  const moves = scramble.split(/\s+/).filter(Boolean);
  return moves.some((move, i) => i > 0 && moveFamily(moves[i - 1]!) === moveFamily(move));
}

async function generateOne(cubeType: CubeType): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const scramble = (await randomScrambleForEvent(SCRAMBLE_EVENT[cubeType])).toString();
    if (hasAdjacentSameLayer(scramble)) continue;
    // ต้องไม่ได้คิวบ์ที่แก้เสร็จอยู่แล้ว (โอกาสน้อยมาก แต่ถ้าเกิดคือแมตช์นั้นเสียทันที)
    if (await isSolved(cubeType, await patternAfterScramble(cubeType, scramble))) continue;
    return scramble;
  }
  throw new Error(`generate scramble ของ ${cubeType} ไม่ผ่านการตรวจครบ ${MAX_ATTEMPTS} ครั้ง`);
}

/** ขอ scramble ที่ผ่านการตรวจแล้ว `count` ชุด */
export async function generateScrambles(cubeType: CubeType, count: number): Promise<string[]> {
  const scrambles: string[] = [];
  for (let i = 0; i < count; i++) scrambles.push(await generateOne(cubeType));
  return scrambles;
}
