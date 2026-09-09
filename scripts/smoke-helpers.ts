/**
 * เครื่องมือที่สโมคเทสทุกตัวใช้ร่วมกัน — เข้าสู่ระบบ · ต่อ socket · รอ event · แก้คิวบ์ให้เสร็จ
 *
 * ทุกตัวคุยกับ server ผ่านสายเดียวกับที่เบราว์เซอร์ใช้จริง (REST + Socket.IO)
 * ไม่มีการเรียกฟังก์ชันฝั่ง server ตรง ๆ — สโมคเทสต้องเห็นสิ่งที่ผู้เล่นจริงเห็นเท่านั้น
 */
import { Alg } from 'cubing/alg';
import { io, type Socket } from 'socket.io-client';

export const SERVER_URL = process.env.SMOKE_SERVER_URL ?? 'http://localhost:4000';
export const API = `${SERVER_URL}/api/v1`;
/** รหัสผ่านของบัญชีตัวอย่างจาก `npm run seed` */
export const SEED_PASSWORD = 'Password123!';

export type Ack<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

let passed = 0;
let failed = 0;

export function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`, detail === undefined ? '' : detail);
  }
}

/** คืน exit code — 0 เมื่อผ่านหมด */
export function summary(note = ''): number {
  console.log(`\nสรุป: ผ่าน ${passed} · ไม่ผ่าน ${failed} ${note}\n`);
  return failed === 0 ? 0 : 1;
}

export async function login(identifier: string): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password: SEED_PASSWORD }),
  });
  const body = (await res.json()) as { data?: { accessToken: string; user: { userId: number } } };
  if (!body.data) throw new Error(`เข้าสู่ระบบ ${identifier} ไม่ผ่าน`);
  return { token: body.data.accessToken, userId: body.data.user.userId };
}

export function connect(token: string): Promise<Socket> {
  const socket = io(SERVER_URL, { auth: { token }, transports: ['websocket'] });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

export function emit<T>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

export function waitFor<T>(socket: Socket, event: string, timeoutMs = 30_000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      resolve(null);
    }, timeoutMs);
    const listener = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

/**
 * ท่าที่ทำให้คิวบ์กลับมาแก้เสร็จ = ย้อน scramble
 * cubing.js เขียน 180° ตอน invert เป็น `U2'` แต่บนสายส่งรับแค่ `U2` (game-rules.md ข้อ 11)
 */
export function solutionMoves(scramble: string): string[] {
  return new Alg(scramble)
    .invert()
    .toString()
    .split(/\s+/)
    .filter(Boolean)
    .map((move) => move.replace(/2'$/, '2'));
}

/**
 * ส่ง move ทีละท่าแบบที่ client จริงทำ (fire-and-forget)
 * `gapMs` = เว้นช่วงระหว่างท่าเหมือนคนหมุนจริง — ใส่ 0 เมื่อจงใจให้เข้าเกณฑ์ soft ของ anti-cheat
 */
export async function sendMoves(socket: Socket, moves: string[], gapMs = 0): Promise<void> {
  for (const [index, move] of moves.entries()) {
    socket.emit('solve:move', { seq: index + 1, move, clientTs: Date.now() });
    if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
}

/** ผลแมตช์ที่ `match:finished` ส่งกลับมา (เท่าที่สโมคเทสใช้) */
export interface SmokeMatchResult {
  matchId: number | null;
  /** `matchId` เป็นเลขของตารางไหน (ADR-044 ข้อ 1) */
  matchKind: '1v1' | 'multiplayer' | null;
  roomKind: 'competitive' | 'multiplayer' | 'custom';
  ratingApplied: boolean;
  scramble: string;
  results: {
    userId: number;
    username: string;
    solveTimeMs: number | null;
    moveCount: number;
    rankNo: number;
    eloBefore: number | null;
    eloAfter: number | null;
    eloChange: number | null;
  }[];
}

/**
 * เล่นหนึ่งรอบในห้องที่มีคนครบแล้ว: host กดเริ่ม → ทุกคนแจ้งพร้อม → รอเริ่มจับเวลา
 * คืน scramble ของรอบนั้นไว้ให้ผู้เรียกสั่ง move ต่อ
 *
 * รับผู้เล่นกี่คนก็ได้ (ห้อง 1v1 ส่งมา 2 · ห้องหลายคนส่งมา 3–4)
 */
export async function startRound(
  hostSocket: Socket,
  ...otherSockets: Socket[]
): Promise<{ scramble: string }> {
  // ต้องดัก match:loading ก่อนสั่งเริ่ม — server ส่ง event ออกก่อนที่ ack จะกลับมาถึง
  const loading = waitFor<{ scramble: string }>(hostSocket, 'match:loading');
  const started = await emit(hostSocket, 'room:start', {});
  if (!started.ok)
    throw new Error(`กดเริ่มไม่ผ่าน: ${started.error.code} ${started.error.message}`);

  const payload = await loading;
  if (!payload) throw new Error('ไม่ได้รับ match:loading');

  for (const socket of [hostSocket, ...otherSockets]) await emit(socket, 'solve:ready', {});
  await waitFor(hostSocket, 'match:started');
  return { scramble: payload.scramble };
}
