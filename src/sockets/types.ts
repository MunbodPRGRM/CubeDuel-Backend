/**
 * สัญญาของ Socket.IO ฝั่ง server — **ไฟล์เดียวของทั้ง repo นี้**
 *
 * แหล่งความจริงคือ `docs/socket-events.md` ห้ามเพิ่ม/แก้ event ที่นี่โดยไม่แก้เอกสารก่อน
 * ⚠️ ต้องตรงกับ `frontend/src/socket/types.ts` เป๊ะ ๆ — คนละ repo ไม่มีอะไรเตือนถ้าลืม (ADR-021)
 */
import type { CubeType } from '../types/cube.js';
import type { SocketErrorCode } from './errors.js';

export type { CubeType };

export type RoomKind = 'competitive' | 'multiplayer' | 'custom';
export type RoomMode = 'auto' | 'custom';

export type RoomState =
  | 'WAITING'
  | 'MATCHED'
  | 'LOADING'
  | 'COUNTDOWN'
  | 'INSPECTION'
  | 'SOLVING'
  | 'FINAL_COUNTDOWN'
  | 'FINISHED'
  | 'ABORTED';

/** state ที่ถือว่า "กำลังแข่งอยู่" — ออกจากห้องกลางคันตอนนี้มีผลกับเกม (ADR-034 ข้อ 4) */
export const ACTIVE_STATES: readonly RoomState[] = [
  'MATCHED',
  'LOADING',
  'COUNTDOWN',
  'INSPECTION',
  'SOLVING',
  'FINAL_COUNTDOWN',
];

export interface PlayerPublic {
  userId: number;
  username: string;
  nickname: string | null;
  /** Elo ของ cube_type ที่กำลังแข่ง (ไม่ใช่ค่ารวม — Rating แยก 4 แถวต่อคน) */
  eloRating: number;
  isHost: boolean;
  isReady: boolean;
  connected: boolean;
}

export type SolveStatus = 'solving' | 'solved' | 'dnf' | 'surrendered';

export interface PlayerProgress {
  userId: number;
  moveCount: number;
  status: SolveStatus;
  /** null = ยังไม่จบ หรือ DNF */
  solveTimeMs: number | null;
}

export interface RoomSnapshot {
  roomId: number;
  roomKind: RoomKind;
  /** null สำหรับห้องแข่งขัน 1v1 */
  roomMode: RoomMode | null;
  /** มีเฉพาะห้องที่สร้างเอง */
  roomCode: string | null;
  cubeType: CubeType;
  state: RoomState;
  maxPlayers: number;
  players: PlayerPublic[];
  progress: PlayerProgress[];
  spectatorCount: number;
  /** ส่งตอน LOADING เป็นต้นไปเท่านั้น */
  scramble: string | null;
  /** เวลาปัจจุบันของ server ใช้ sync นาฬิกา */
  serverTs: number;
  /** เวลาที่ phase ปัจจุบันจะจบ (countdown / inspection / final countdown) */
  phaseEndsAtTs: number | null;
  /** เวลาที่เริ่มจับเวลา — มีค่าตั้งแต่ SOLVING */
  serverStartTs: number | null;
  /**
   * แถวผลของรอบล่าสุดในห้องนี้ — `null` จนกว่ารอบแรกจะจบและบันทึกสำเร็จ
   * ใช้เปิดผลย้อนหลังตอนไม่ได้รับ `match:finished` (ADR-040 ข้อ 5)
   */
  matchId: number | null;
  /** `matchId` เป็นเลขของตารางไหน — `null` เมื่อ `matchId` เป็น `null` (ADR-044 ข้อ 1) */
  matchKind: MatchKind | null;
  /** server นี้รับ `solve:dev_finish` ไหม — ปุ่มทดสอบ (ADR-060) · ⚠️ ถอดออกก่อน deploy */
  devInstantFinish: boolean;
}

/**
 * ตารางที่เก็บผลของรอบนั้น — **`match_id` กับ `multiplayer_match_id` ชนกันได้ตลอด**
 * เพราะเป็น auto-increment คนละตัว client จึงต้องรู้ว่าเลขที่ได้มาเป็นของใคร (ADR-044 ข้อ 1)
 */
export type MatchKind = '1v1' | 'multiplayer';

// ---------------------------------------------------------------- ack

export interface AckError {
  code: SocketErrorCode;
  message: string;
}

export type Ack<T> = { ok: true; data: T } | { ok: false; error: AckError };

/** callback ที่ client แนบมากับ event — อาจไม่แนบมาก็ได้ (fire-and-forget) */
export type AckFn<T> = (response: Ack<T>) => void;

// ---------------------------------------------------------------- payload

export interface NetPingPayload {
  clientTs: number;
  /** RTT ที่ client วัดได้จาก ping ครั้งก่อน — ครั้งแรกไม่ต้องส่ง */
  lastRttMs?: number;
}
export interface NetPingResult {
  serverTs: number;
  clientTs: number;
}

/**
 * คิวจับคู่อัตโนมัติ — คนละช่องคิวกันโดยสิ้นเชิง (แยกตาม `kind` + `cubeType`)
 *   - `competitive` = 1v1 มีช่วง Elo ขยายตามเวลารอ
 *   - `multiplayer` = 3–4 คน ไม่ใช้ช่วง Elo จับตามลำดับเข้าคิว (game-rules.md ข้อ 8)
 */
export type QueueKind = 'competitive' | 'multiplayer';

export interface QueueJoinPayload {
  cubeType: CubeType;
  kind: QueueKind;
}
export interface QueueJoinResult {
  queuedAtTs: number;
  playersInQueue: number;
}
export interface QueueLeaveResult {
  /** false = ไม่ได้อยู่ในคิวอยู่แล้ว (ไม่ถือว่าผิดพลาด) */
  left: boolean;
}
export interface QueueStatusPayload {
  /** ช่องคิวที่กำลังรออยู่ — client เดาเองไม่ได้เพราะ server พาเข้าคิวเองได้ (ADR-044 ข้อ 2) */
  kind: QueueKind;
  cubeType: CubeType;
  waitedMs: number;
  /**
   * null = ไม่จำกัดช่วงคะแนน — คิว 1v1 ที่รอเกิน 120 วิ (game-rules.md ข้อ 8)
   * และ **คิวห้องผู้เล่นหลายคนเสมอ** เพราะไม่ใช้ช่วง Elo เลย
   */
  eloWindow: number | null;
  /** จำนวนคนในคิวช่องเดียวกัน (kind + cubeType) รวมตัวเอง */
  playersInQueue: number;
}
export interface QueueMatchedPayload {
  roomId: number;
  cubeType: CubeType;
  players: PlayerPublic[];
}
export interface QueueTimeoutPayload {
  waitedMs: number;
}

export interface RoomCreatePayload {
  cubeType: CubeType;
  /** `custom` = 1v1 (2 คน) · `multiplayer` = 3–4 คน · ทั้งคู่เป็นห้องที่มีรหัสห้อง */
  kind: 'custom' | 'multiplayer';
  maxPlayers: 2 | 3 | 4;
}
export interface RoomCreateResult {
  roomId: number;
  roomCode: string;
}

export interface RoomJoinPayload {
  roomCode: string;
  as: 'player' | 'spectator';
}
export interface RoomRejoinPayload {
  roomId: number;
}
export interface RoomSnapshotResult {
  snapshot: RoomSnapshot;
}

export interface RoomReadyPayload {
  ready: boolean;
}

export type LeaveReason = 'left' | 'disconnected' | 'kicked';
export type AbortReason = 'player_left' | 'timeout' | 'host_left';

export interface SolveMovePayload {
  /** เริ่มที่ 1 เพิ่มทีละ 1 — ข้ามหรือซ้ำ = `E_SEQ_MISMATCH` */
  seq: number;
  /** notation ตัวเดียว เช่น `R`, `U'`, `F2` — ห้ามหลาย move ใน string เดียว */
  move: string;
  clientTs: number;
}

export interface SolveSolvedPayload {
  seq: number;
  moveCount: number;
  clientTs: number;
}

export interface SolveSolvedResult {
  solveTimeMs: number;
  rankNo: number;
}

/**
 * `solve:camera` — มุมกล้องของผู้เล่น (ADR-062)
 * `q` = quaternion ของกล้อง `[x, y, z, w]` · `d` = ระยะจากจุดศูนย์กลางคิวบ์ → ตำแหน่ง = `q · (0, 0, d)`
 */
export interface SolveCameraPayload {
  q: [number, number, number, number];
  d: number;
}
export interface OpponentCameraPayload extends SolveCameraPayload {
  userId: number;
}

export type DnfReason = 'surrender' | 'timeout' | 'disconnect' | 'invalid';

// ---------------------------------------------------------------- ผลการแข่งขัน

export interface MatchResultEntry {
  userId: number;
  username: string;
  /** null = DNF */
  solveTimeMs: number | null;
  moveCount: number;
  rankNo: number;
  /** null = ห้องที่ไม่ปรับคะแนน */
  eloBefore: number | null;
  eloAfter: number | null;
  eloChange: number | null;
}

export interface MatchResult {
  /** null = ห้องที่ไม่บันทึก DB */
  matchId: number | null;
  /** `matchId` เป็นเลขของตารางไหน — `null` เมื่อ `matchId` เป็น `null` (ADR-044 ข้อ 1) */
  matchKind: MatchKind | null;
  roomKind: RoomKind;
  cubeType: CubeType;
  scramble: string;
  /** true เฉพาะห้องแข่งขัน + ห้องหลายคนโหมด auto */
  ratingApplied: boolean;
  /** เรียงตาม rankNo แล้ว client ไม่ต้องเรียงเอง */
  results: MatchResultEntry[];
  finishedAtTs: number;
}

// ---------------------------------------------------------------- event map

export interface ClientToServerEvents {
  'net:ping': (payload: NetPingPayload, ack?: AckFn<NetPingResult>) => void;
  'queue:join': (payload: QueueJoinPayload, ack?: AckFn<QueueJoinResult>) => void;
  'queue:leave': (payload: Record<string, never>, ack?: AckFn<QueueLeaveResult>) => void;
  'room:create': (payload: RoomCreatePayload, ack?: AckFn<RoomCreateResult>) => void;
  'room:join': (payload: RoomJoinPayload, ack?: AckFn<RoomSnapshotResult>) => void;
  'room:rejoin': (payload: RoomRejoinPayload, ack?: AckFn<RoomSnapshotResult>) => void;
  'room:leave': (payload: Record<string, never>, ack?: AckFn<null>) => void;
  'room:ready': (payload: RoomReadyPayload, ack?: AckFn<null>) => void;
  'room:start': (payload: Record<string, never>, ack?: AckFn<null>) => void;
  'solve:ready': (payload: Record<string, never>, ack?: AckFn<null>) => void;
  /** ไม่มี ack เพื่อความลื่น — server เงียบถ้าผ่าน ผิดเมื่อไรส่ง event `error` */
  'solve:move': (payload: SolveMovePayload) => void;
  'solve:solved': (payload: SolveSolvedPayload, ack?: AckFn<SolveSolvedResult>) => void;
  'solve:surrender': (payload: Record<string, never>, ack?: AckFn<null>) => void;
  /** ปุ่มทดสอบ — ปฏิเสธเสมอถ้าไม่ได้เปิด `DEV_INSTANT_FINISH` (ADR-060) */
  'solve:dev_finish': (payload: Record<string, never>, ack?: AckFn<SolveSolvedResult>) => void;
  /** ไม่มี ack · ผิดแล้วทิ้งเงียบ ไม่ส่ง `error` กลับ (ADR-062) */
  'solve:camera': (payload: SolveCameraPayload) => void;
}

export interface ServerToClientEvents {
  'queue:status': (payload: QueueStatusPayload) => void;
  'queue:matched': (payload: QueueMatchedPayload) => void;
  'queue:timeout': (payload: QueueTimeoutPayload) => void;

  'room:state': (snapshot: RoomSnapshot) => void;
  'room:player_joined': (payload: { player: PlayerPublic }) => void;
  'room:player_left': (payload: { userId: number; reason: LeaveReason }) => void;
  'room:host_changed': (payload: { newHostUserId: number }) => void;
  'room:ready_changed': (payload: { userId: number; ready: boolean }) => void;
  'room:spectator_count': (payload: { count: number }) => void;
  'room:aborted': (payload: { reason: AbortReason; message: string }) => void;

  'match:loading': (payload: { scramble: string; cubeType: CubeType; deadlineTs: number }) => void;
  'match:countdown': (payload: { startsAtTs: number; durationMs: number }) => void;
  'match:inspection_started': (payload: { endsAtTs: number; durationMs: number }) => void;
  'match:started': (payload: { serverStartTs: number }) => void;
  'match:final_countdown': (payload: {
    firstSolverUserId: number;
    endsAtTs: number;
    durationMs: number;
  }) => void;
  'match:finished': (payload: MatchResult) => void;

  'opponent:move': (payload: {
    userId: number;
    seq: number;
    move: string;
    serverTs: number;
  }) => void;
  'opponent:progress': (payload: { userId: number; moveCount: number; elapsedMs: number }) => void;
  'opponent:camera': (payload: OpponentCameraPayload) => void;
  'player:solved': (payload: {
    userId: number;
    solveTimeMs: number;
    moveCount: number;
    rankNo: number;
  }) => void;
  'player:dnf': (payload: { userId: number; reason: DnfReason }) => void;
  'player:disconnected': (payload: { userId: number; graceEndsAtTs: number }) => void;
  'player:reconnected': (payload: { userId: number }) => void;

  error: (payload: AckError) => void;
}

/** ข้อมูลที่ผูกกับ socket หนึ่งตัว — ตั้งใน middleware ตอน handshake */
export interface SocketData {
  userId: number;
  username: string;
  nickname: string | null;
  role: 'member' | 'admin';
  /** RTT ล่าสุดจาก `net:ping` — ใช้ชดเชยเวลาตอนตัดสินผล (game-rules.md ข้อ 3) */
  rttMs: number | null;
  /** ห้องที่ socket นี้อยู่ (`null` = ยังไม่ได้เข้าห้องไหน) */
  roomId: number | null;
  /** เข้ามาในฐานะอะไร — ผู้ชมส่ง `solve:*` ไม่ได้ */
  seat: 'player' | 'spectator' | null;
}

/** ชื่อ Socket.IO room ของผู้เล่น กับของผู้ชม (แยกกันเพื่อ broadcast คนละชุด) */
export function playerRoomName(roomId: number): string {
  return `room:${roomId}`;
}
export function spectatorRoomName(roomId: number): string {
  return `spectate:${roomId}`;
}
