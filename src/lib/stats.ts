/**
 * สถิติของผู้เล่นแบบ WCA — Best / Worst / Mean / Ao5 / Ao12 / Ao100 + สตรีคชนะ
 * ที่มา: `docs/api-contract.md` ข้อ 4 · นิยามสตรีคอยู่ใน ADR-045 ข้อ 2
 *
 * แยกจาก service เพราะเป็นเลขล้วน ๆ ไม่แตะ DB — เขียน unit test ได้ตรง ๆ แบบเดียวกับ
 * `lib/ranking.ts` และ `lib/elo.ts` (ADR-038 ข้อ 3)
 *
 * **ลิสต์ที่รับเข้ามาเรียงจากใหม่ไปเก่าเสมอ** (ตัวที่ index 0 คือ solve ล่าสุด)
 * `null` ในลิสต์เวลา = DNF/ยอมแพ้ เสมอ ห้ามใช้ 0 แทน (database-schema.md)
 */

/** ผลของแมตช์หนึ่งแมตช์เมื่อมองจากผู้เล่นคนหนึ่ง — กติกาเดียวกับที่ `Rating` นับ (ADR-041 ข้อ 1) */
export type MatchOutcomeForUser = 'win' | 'loss' | 'draw';

/** วินาที — ปัดครึ่งขึ้นเป็นทศนิยม 2 ตำแหน่ง (เวลาดิบถูกปัดลงตั้งแต่ตอนบันทึกแล้ว) */
export function roundSeconds(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function solvedOnly(times: readonly (number | null)[]): number[] {
  return times.filter((time): time is number => time !== null);
}

/** เวลาที่ดีที่สุด ไม่นับ DNF — `null` = ยังไม่เคยแก้สำเร็จเลย */
export function bestTime(times: readonly (number | null)[]): number | null {
  const solved = solvedOnly(times);
  return solved.length === 0 ? null : Math.min(...solved);
}

/** เวลาที่แย่ที่สุด **ในกลุ่มที่แก้สำเร็จ** — DNF ไม่มีเวลาให้เทียบ จึงไม่นับ */
export function worstTime(times: readonly (number | null)[]): number | null {
  const solved = solvedOnly(times);
  return solved.length === 0 ? null : Math.max(...solved);
}

/** ค่าเฉลี่ยของ solve ที่สำเร็จทั้งหมด (ไม่นับ DNF) */
export function meanTime(times: readonly (number | null)[]): number | null {
  const solved = solvedOnly(times);
  if (solved.length === 0) return null;
  return roundSeconds(solved.reduce((sum, time) => sum + time, 0) / solved.length);
}

/**
 * Average of N ตามธรรมเนียม WCA — เอา **N ครั้งล่าสุด** ตัดเร็วสุด 1 + ช้าสุด 1 แล้วเฉลี่ยที่เหลือ
 *
 * เคสที่พลาดกันบ่อย (api-contract.md ข้อ 4):
 *   - ยังไม่ครบ N ครั้ง → `null` **ไม่ใช่** เฉลี่ยเท่าที่มี
 *   - DNF 1 ครั้ง → นับเป็นตัวที่ช้าที่สุด แล้วถูกตัดทิ้งไปพร้อมกับตัวที่เร็วที่สุด
 *   - DNF ตั้งแต่ 2 ครั้งขึ้นไปใน N นั้น → `null` (DNF average) เพราะตัวที่สองตัดทิ้งไม่ได้
 */
export function averageOfN(recentFirst: readonly (number | null)[], n: number): number | null {
  if (n < 3) throw new Error(`averageOfN ต้องใช้ N อย่างน้อย 3 (ได้ ${n})`);
  if (recentFirst.length < n) return null;

  const window = recentFirst.slice(0, n);
  const dnfCount = window.length - solvedOnly(window).length;
  if (dnfCount > 1) return null;

  const sorted = solvedOnly(window).sort((a, b) => a - b);
  // DNF คือตัวช้าที่สุดอยู่แล้วและไม่อยู่ใน `sorted` → เหลือตัดแค่ตัวที่เร็วที่สุด
  const trimmed = dnfCount === 1 ? sorted.slice(1) : sorted.slice(1, -1);

  return roundSeconds(trimmed.reduce((sum, time) => sum + time, 0) / trimmed.length);
}

/**
 * สตรีคชนะ — `current` นับย้อนจากแมตช์ล่าสุดและ **ขาดทันทีที่เจอแมตช์ที่ไม่ชนะ** (แพ้หรือเสมอ)
 * `best` คือช่วงชนะติดกันที่ยาวที่สุดตลอดประวัติ (ADR-045 ข้อ 2)
 *
 * คนละตัวกับเกณฑ์ `WIN_STREAK` ของระบบกันโกง (ADR-038 ข้อ 4) ที่นับเฉพาะห้องแข่งขัน
 * และดู Elo ของคู่แข่งประกอบ — ตัวนี้เป็นตัวเลขโชว์บนโปรไฟล์ นับทุกแมตช์ที่บันทึกลง DB
 */
export function winStreaks(outcomesRecentFirst: readonly MatchOutcomeForUser[]): {
  current: number;
  best: number;
} {
  let current = 0;
  for (const outcome of outcomesRecentFirst) {
    if (outcome !== 'win') break;
    current += 1;
  }

  let best = 0;
  let run = 0;
  for (const outcome of outcomesRecentFirst) {
    run = outcome === 'win' ? run + 1 : 0;
    if (run > best) best = run;
  }

  return { current, best };
}

/** `wins / (wins + losses + draws)` ปัดทศนิยม 4 ตำแหน่ง (api-contract.md ข้อ 4 + ข้อ 5) */
export function winRateOf(wins: number, losses: number, draws: number): number {
  const played = wins + losses + draws;
  if (played === 0) return 0;
  return Number((wins / played).toFixed(4));
}
