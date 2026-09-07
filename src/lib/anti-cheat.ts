/**
 * เกณฑ์ soft ของ anti-cheat — **บันทึก flag ไว้ให้แอดมินดู ไม่ปฏิเสธผล**
 * (docs/game-rules.md ข้อ 10 · นิยามที่แปลงเป็นตัวเลขจริงอยู่ใน ADR-035 ข้อ 7)
 *
 * ฟังก์ชันในไฟล์นี้เป็น pure ทั้งหมด — ไม่แตะ DB ไม่แตะห้อง เพื่อให้เขียนเทสตรง ๆ ได้
 */
import { FlagReason } from '@prisma/client';
import type { ApiCubeType } from '../types/cube.js';

/** เวลาที่ต่ำกว่านี้ถือว่าผิดปกติ (วินาที) */
const MIN_PLAUSIBLE_SECONDS: Record<ApiCubeType, number> = {
  '2x2x2': 0.8,
  '3x3x3': 3.5,
  pyraminx: 0.9,
  pyramorphix: 0.9,
};

/** 3x3x3 ที่น้อยกว่านี้ถือว่าน้อยผิดปกติ (God's number = 20) — ประเภทอื่นไม่มีเกณฑ์นี้ */
const MIN_PLAUSIBLE_MOVES_3X3X3 = 18;

/** เกิน 15 moves/วินาที ต่อเนื่องเกิน 10 moves = 11 move ติดกันภายใน 10/15 วินาที */
const TPS_LIMIT = 15;
const TPS_WINDOW_MOVES = 10;
const TPS_WINDOW_MS = (TPS_WINDOW_MOVES / TPS_LIMIT) * 1_000;

/** move ที่ห่างกันน้อยกว่า 20 ms ติดกันเกิน 5 ครั้ง */
const MIN_GAP_MS = 20;
const MAX_TIGHT_GAPS = 5;

export interface SolveSample {
  cubeType: ApiCubeType;
  /** เวลาที่ใช้จริงหน่วยมิลลิวินาที (ผลที่ผ่านการตรวจแล้ว) */
  solveTimeMs: number;
  moveCount: number;
  /** เวลาที่ server ได้รับแต่ละ move นับจาก serverStartTs เรียงจากน้อยไปมาก */
  moveTimestampsMs: readonly number[];
}

export interface SoftFlag {
  reason: FlagReason;
  /** ลงคอลัมน์ `MatchFlag.detail` ตรง ๆ */
  detail: Record<string, unknown>;
}

/** เร็วเกินกว่าที่มนุษย์ทำได้ในประเภทนั้น */
function checkImpossibleTime(sample: SolveSample): SoftFlag | null {
  const threshold = MIN_PLAUSIBLE_SECONDS[sample.cubeType];
  const measured = sample.solveTimeMs / 1_000;
  if (measured >= threshold) return null;
  return {
    reason: FlagReason.IMPOSSIBLE_TIME,
    detail: {
      metric: 'solve_time_seconds',
      measured: Number(measured.toFixed(2)),
      threshold,
      cubeType: sample.cubeType,
    },
  };
}

/** จำนวน move น้อยผิดปกติ (เฉพาะ 3x3x3 ที่มีค่าอ้างอิงชัด) */
function checkLowMoveCount(sample: SolveSample): SoftFlag | null {
  if (sample.cubeType !== '3x3x3') return null;
  if (sample.moveCount >= MIN_PLAUSIBLE_MOVES_3X3X3) return null;
  return {
    reason: FlagReason.LOW_MOVE_COUNT,
    detail: {
      metric: 'move_count',
      measured: sample.moveCount,
      threshold: MIN_PLAUSIBLE_MOVES_3X3X3,
      cubeType: sample.cubeType,
    },
  };
}

/** หมุนเร็วเกิน 15 TPS ต่อเนื่องเกิน 10 move */
function checkHighTps(sample: SolveSample): SoftFlag | null {
  const times = sample.moveTimestampsMs;
  for (let i = 0; i + TPS_WINDOW_MOVES < times.length; i++) {
    const spanMs = times[i + TPS_WINDOW_MOVES]! - times[i]!;
    if (spanMs >= TPS_WINDOW_MS) continue;
    return {
      reason: FlagReason.HIGH_TPS,
      detail: {
        metric: 'turns_per_second',
        measured: Number(((TPS_WINDOW_MOVES / spanMs) * 1_000).toFixed(2)),
        threshold: TPS_LIMIT,
        windowMoves: TPS_WINDOW_MOVES + 1,
        atMoveIndex: i + 1,
        cubeType: sample.cubeType,
      },
    };
  }
  return null;
}

/** move ห่างกันน้อยกว่า 20 ms ติดกันเกิน 5 ครั้ง */
function checkMoveGap(sample: SolveSample): SoftFlag | null {
  const times = sample.moveTimestampsMs;
  let run = 0;
  for (let i = 1; i < times.length; i++) {
    run = times[i]! - times[i - 1]! < MIN_GAP_MS ? run + 1 : 0;
    if (run < MAX_TIGHT_GAPS) continue;
    return {
      reason: FlagReason.MOVE_GAP,
      detail: {
        metric: 'consecutive_gaps_under_ms',
        measured: run,
        threshold: MAX_TIGHT_GAPS,
        gapMs: MIN_GAP_MS,
        atMoveIndex: i + 1,
        cubeType: sample.cubeType,
      },
    };
  }
  return null;
}

/**
 * ตรวจ solve หนึ่งครั้งกับเกณฑ์ soft ทั้งหมดที่ทำได้ตอนนี้
 *
 * `WIN_STREAK` ไม่อยู่ที่นี่ — ต้องอ่านประวัติแมตช์ย้อนหลังและมีความหมายเฉพาะห้องที่ปรับคะแนน
 * จึงยกไปทำพร้อมห้องแข่งขันในเฟส 5 (ADR-035 ข้อ 7)
 */
export function inspectSolve(sample: SolveSample): SoftFlag[] {
  return [
    checkImpossibleTime(sample),
    checkLowMoveCount(sample),
    checkHighTps(sample),
    checkMoveGap(sample),
  ].filter((flag): flag is SoftFlag => flag !== null);
}
