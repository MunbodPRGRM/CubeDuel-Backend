/**
 * ตรรกะการเลือกคู่/จับกลุ่มของคิวจับคู่อัตโนมัติ — **pure function ล้วน** (ADR-039 ข้อ 8)
 *
 * ที่มาของกติกา: `docs/game-rules.md` ข้อ 8
 *   - 1v1 (`pairUp`) — ช่วง Elo ขยายตามเวลารอ · ห้ามเจอคนเดิมซ้ำติดกัน
 *   - หลายคน (`groupUp`) — **ไม่ใช้ช่วง Elo** จับตามลำดับเข้าคิว (ADR-043 ข้อ 1)
 * ไฟล์นี้ไม่รู้จัก socket / prisma / Room — เวลาส่งเข้ามาเป็นพารามิเตอร์ `now` เสมอ
 * เพื่อให้เทสคุมกติกาได้โดยไม่ต้องตั้ง server (ทางเดียวกับ `lib/elo.ts` — ADR-038 ข้อ 2)
 */
import {
  MULTIPLAYER_ROOM_MAX,
  MULTIPLAYER_ROOM_MIN,
  MULTIPLAYER_SHORT_GROUP_AFTER_MS,
} from '../constants.js';

/** ช่วง Elo ที่ยอมรับ ตามเวลาที่รอมาแล้ว (game-rules.md ข้อ 8) — `null` = ไม่จำกัด */
const ELO_WINDOW_STEPS: readonly { untilMs: number; window: number }[] = [
  { untilMs: 10_000, window: 100 },
  { untilMs: 30_000, window: 200 },
  { untilMs: 60_000, window: 350 },
  { untilMs: 120_000, window: 600 },
];

/**
 * ช่วง Elo ที่คนรอมา `waitedMs` ยอมรับได้ — `null` = ใครก็ได้ที่อยู่ในคิว
 * ขอบเขตนับแบบ "ต่ำกว่า" (รอครบ 10 วินาทีเป๊ะ = ขยับเป็น ±200 แล้ว)
 */
export function eloWindowFor(waitedMs: number): number | null {
  for (const step of ELO_WINDOW_STEPS) {
    if (waitedMs < step.untilMs) return step.window;
  }
  return null;
}

/** สิ่งที่การจับกลุ่มห้องหลายคนต้องรู้ — แค่ว่าใครและเข้าคิวมาตั้งแต่เมื่อไร */
export interface QueueWaiter {
  userId: number;
  queuedAtTs: number;
}

export interface QueueCandidate extends QueueWaiter {
  /** Elo ของ `cube_type` ที่จะแข่ง — อ่านตอนเข้าคิวครั้งเดียว */
  eloRating: number;
  /** คู่แข่งคนล่าสุด — เลี่ยงไว้ก่อนถ้ายังมีตัวเลือกอื่น (game-rules.md ข้อ 8) */
  lastOpponentId: number | null;
}

/** ลำดับสิทธิ์ในคิว: รอนานกว่าได้ก่อน · เข้าคิวพร้อมกันตัดสินด้วย `userId` ให้ผลคงที่ */
function byWaitOrder(a: QueueWaiter, b: QueueWaiter): number {
  return a.queuedAtTs - b.queuedAtTs || a.userId - b.userId;
}

export interface QueuePair {
  a: QueueCandidate;
  b: QueueCandidate;
}

/**
 * จับคู่ได้ไหม — ใช้ช่วงของ **ฝั่งที่ใจกว้างกว่า** (ADR-039 ข้อ 2)
 * เพราะกติกาเขียนว่ารอเกิน 120 วิแล้ว "ใครก็ได้ที่อยู่ในคิว" ซึ่งเป็นจริงไม่ได้ถ้าต้องผ่านทั้งสองฝั่ง
 */
export function withinEloWindow(a: QueueCandidate, b: QueueCandidate, now: number): boolean {
  const windowA = eloWindowFor(now - a.queuedAtTs);
  const windowB = eloWindowFor(now - b.queuedAtTs);
  if (windowA === null || windowB === null) return true;
  return Math.abs(a.eloRating - b.eloRating) <= Math.max(windowA, windowB);
}

/** เคยเจอกันเป็นคู่ล่าสุดของฝั่งใดฝั่งหนึ่งไหม */
function isRematch(a: QueueCandidate, b: QueueCandidate): boolean {
  return a.lastOpponentId === b.userId || b.lastOpponentId === a.userId;
}

/**
 * เลือกคู่ที่ดีที่สุดของ `target` จาก `candidates` — คะแนนใกล้สุดก่อน เท่ากันเอาคนที่รอนานกว่า
 * (`userId` เป็นตัวตัดสินสุดท้ายเพื่อให้ผลคงที่ทุกครั้งที่รันด้วยอินพุตเดิม)
 */
function pickClosest(target: QueueCandidate, candidates: QueueCandidate[]): QueueCandidate | null {
  let best: QueueCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const gap = Math.abs(candidate.eloRating - target.eloRating);
    const bestGap = Math.abs(best.eloRating - target.eloRating);
    if (gap < bestGap) best = candidate;
    else if (gap === bestGap && candidate.queuedAtTs < best.queuedAtTs) best = candidate;
    else if (
      gap === bestGap &&
      candidate.queuedAtTs === best.queuedAtTs &&
      candidate.userId < best.userId
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * จับคู่ทั้งช่องคิว (ผู้เรียกแยกช่องตาม `kind` + `cubeType` มาแล้ว)
 *
 * greedy: คนที่รอนานสุดเลือกก่อน → ตัดคู่ล่าสุดออกถ้ายังเหลือตัวเลือกอื่น → เอาคะแนนใกล้สุด
 * (ADR-039 ข้อ 3) · คนที่จับคู่ไม่ได้รอบนี้ก็รอ tick ถัดไปซึ่งช่วง Elo จะกว้างขึ้นเอง
 */
export function pairUp(entries: readonly QueueCandidate[], now: number): QueuePair[] {
  const waiting = [...entries].sort(byWaitOrder);
  const taken = new Set<number>();
  const pairs: QueuePair[] = [];

  for (const target of waiting) {
    if (taken.has(target.userId)) continue;

    const eligible = waiting.filter(
      (other) =>
        other.userId !== target.userId &&
        !taken.has(other.userId) &&
        withinEloWindow(target, other, now),
    );
    if (eligible.length === 0) continue;

    // เลี่ยงคู่เดิม "ถ้ามีตัวเลือกอื่นในคิว" — ไม่มีตัวเลือกอื่นก็จับคู่เดิมได้
    const fresh = eligible.filter((other) => !isRematch(target, other));
    const opponent = pickClosest(target, fresh.length > 0 ? fresh : eligible);
    if (!opponent) continue;

    taken.add(target.userId);
    taken.add(opponent.userId);
    pairs.push({ a: target, b: opponent });
  }

  return pairs;
}

// ---------------------------------------------------------------- ห้องผู้เล่นหลายคน

/**
 * จับกลุ่ม 3–4 คนของคิวห้องผู้เล่นหลายคน (ผู้เรียกแยกช่องตาม `kind` + `cubeType` มาแล้ว)
 *
 * กติกา (`game-rules.md` ข้อ 8): **ครบ 4 คนเริ่มทันที** · ถ้ายังไม่ครบ 4 แต่มีอย่างน้อย 3 คน
 * และคนที่รอนานที่สุดรอเกิน 60 วินาทีแล้ว ให้เริ่มด้วย 3 คน · **ไม่ใช้ช่วง Elo เลย**
 * เพราะกลุ่มใหญ่หาคนครบยากกว่ามาก (ADR-043 ข้อ 1)
 *
 * "ครบ 4 เริ่มทันที" มาก่อนเสมอ — คิวที่มี 6 คนจึงได้ห้อง 4 คนหนึ่งห้อง แล้วอีก 2 คนรอต่อ
 * ไม่ใช่แตกเป็น 3+3 (ADR-043 ข้อ 2)
 */
export function groupUp(entries: readonly QueueWaiter[], now: number): QueueWaiter[][] {
  const waiting = [...entries].sort(byWaitOrder);
  const groups: QueueWaiter[][] = [];

  while (waiting.length >= MULTIPLAYER_ROOM_MIN) {
    if (waiting.length >= MULTIPLAYER_ROOM_MAX) {
      groups.push(waiting.splice(0, MULTIPLAYER_ROOM_MAX));
      continue;
    }
    // เหลือไม่ถึง 4 — ต้องให้คนหัวคิวรอครบ 60 วินาทีก่อนจึงยอมเริ่มด้วยกลุ่มเล็ก
    const head = waiting[0]!;
    if (now - head.queuedAtTs < MULTIPLAYER_SHORT_GROUP_AFTER_MS) break;
    groups.push(waiting.splice(0, MULTIPLAYER_ROOM_MIN));
  }

  return groups;
}
