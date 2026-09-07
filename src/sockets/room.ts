/**
 * ห้องหนึ่งห้องในหน่วยความจำ — ยังไม่มีลำดับการแข่ง (ก้อนที่ 2 จะมาต่อที่นี่)
 *
 * กติกาที่ยึด: `docs/game-rules.md` ข้อ 9 (ห้องสร้างเอง/ผู้ชม/การโอน host)
 * ตัวตนของผู้เล่นคือ `userId` **ไม่ใช่ socket id** — คนหนึ่งเปิดได้หลายแท็บ (ADR-034 ข้อ 3)
 */
import type {
  CubeType,
  PlayerProgress,
  PlayerPublic,
  RoomKind,
  RoomMode,
  RoomSnapshot,
  RoomState,
  SolveStatus,
} from './types.js';

/** ผู้ชมสูงสุดต่อห้อง (game-rules.md ข้อ 9) */
export const MAX_SPECTATORS = 50;

export interface RoomPlayer {
  userId: number;
  username: string;
  nickname: string | null;
  /** Elo ของ cubeType ที่ห้องนี้แข่ง — อ่านตอนเข้าห้อง ไม่อัปเดตระหว่างอยู่ในห้อง */
  eloRating: number;
  isReady: boolean;
  /** socket ทุกตัวของผู้เล่นคนนี้ — ว่าง = หลุดการเชื่อมต่ออยู่ */
  sockets: Set<string>;
  /** ลำดับที่เข้าห้อง เริ่มที่ 1 — คนแรกคือ `player1_id` ตอนบันทึก DB (database-schema.md) */
  seatNo: number;
  // ---- ความคืบหน้าตอนแข่ง (ก้อนที่ 2 เป็นคนเขียน) ----
  moveCount: number;
  status: SolveStatus;
  solveTimeMs: number | null;
}

export interface RoomOptions {
  roomId: number;
  roomKind: RoomKind;
  roomMode: RoomMode | null;
  roomCode: string | null;
  cubeType: CubeType;
  maxPlayers: number;
}

export class Room {
  readonly roomId: number;
  readonly roomKind: RoomKind;
  readonly roomMode: RoomMode | null;
  readonly roomCode: string | null;
  readonly cubeType: CubeType;
  readonly maxPlayers: number;
  readonly createdAtTs = Date.now();

  state: RoomState = 'WAITING';
  scramble: string | null = null;
  phaseEndsAtTs: number | null = null;
  serverStartTs: number | null = null;
  hostUserId: number | null = null;
  /** ไว้ให้สวีปเปอร์ยุบห้องร้าง — ทุก handler ที่แตะห้องต้องเรียก `touch()` */
  lastActivityTs = Date.now();
  /** จำนวนผู้ชมสูงสุดที่เคยมี — บันทึกลง `Match.spectator_count` ตอนจบ */
  peakSpectatorCount = 0;

  /** เรียงตามลำดับที่เข้าห้อง (Map คงลำดับการใส่) */
  readonly players = new Map<number, RoomPlayer>();
  /** userId ของผู้ชม → socket ของคนนั้น */
  readonly spectators = new Map<number, Set<string>>();

  #nextSeatNo = 1;

  constructor(options: RoomOptions) {
    this.roomId = options.roomId;
    this.roomKind = options.roomKind;
    this.roomMode = options.roomMode;
    this.roomCode = options.roomCode;
    this.cubeType = options.cubeType;
    this.maxPlayers = options.maxPlayers;
  }

  touch(): void {
    this.lastActivityTs = Date.now();
  }

  get isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  get spectatorCount(): number {
    return this.spectators.size;
  }

  /** ห้องนี้ไม่มีใครเหลืออยู่แล้ว (ทั้งผู้เล่นและผู้ชม) */
  get isEmpty(): boolean {
    return this.players.size === 0 && this.spectators.size === 0;
  }

  // ---------------------------------------------------------------- ผู้เล่น

  addPlayer(
    profile: Omit<RoomPlayer, 'sockets' | 'seatNo' | 'moveCount' | 'status' | 'solveTimeMs'>,
  ): RoomPlayer {
    const player: RoomPlayer = {
      ...profile,
      sockets: new Set(),
      seatNo: this.#nextSeatNo++,
      moveCount: 0,
      status: 'solving',
      solveTimeMs: null,
    };
    this.players.set(player.userId, player);
    this.hostUserId ??= player.userId;
    this.touch();
    return player;
  }

  removePlayer(userId: number): RoomPlayer | null {
    const player = this.players.get(userId);
    if (!player) return null;
    this.players.delete(userId);
    this.touch();
    return player;
  }

  /**
   * host ออกก่อนเริ่ม → โอนสิทธิ์ให้ผู้เล่นที่เข้ามาถัดไป (game-rules.md ข้อ 9)
   * คืน `userId` ของ host คนใหม่ ถ้าไม่มีการเปลี่ยนคืน `null`
   */
  reassignHostIfNeeded(): number | null {
    if (this.hostUserId !== null && this.players.has(this.hostUserId)) return null;
    const next = this.players.values().next();
    this.hostUserId = next.done ? null : next.value.userId;
    return this.hostUserId;
  }

  isHost(userId: number): boolean {
    return this.hostUserId === userId;
  }

  // ---------------------------------------------------------------- ผู้ชม

  addSpectatorSocket(userId: number, socketId: string): void {
    const sockets = this.spectators.get(userId) ?? new Set<string>();
    sockets.add(socketId);
    this.spectators.set(userId, sockets);
    this.peakSpectatorCount = Math.max(this.peakSpectatorCount, this.spectators.size);
    this.touch();
  }

  /** เอาผู้ชมออกทั้งคน (ทุก socket) — ใช้ตอนกดออกเอง ไม่ใช่ตอนหลุดการเชื่อมต่อ */
  removeSpectator(userId: number): void {
    if (this.spectators.delete(userId)) this.touch();
  }

  /** คืน `true` ถ้าคนนี้ออกจากห้องผู้ชมจริง (socket หมดแล้ว) */
  removeSpectatorSocket(userId: number, socketId: string): boolean {
    const sockets = this.spectators.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size > 0) return false;
    this.spectators.delete(userId);
    this.touch();
    return true;
  }

  // ---------------------------------------------------------------- snapshot

  toPublicPlayer(player: RoomPlayer): PlayerPublic {
    return {
      userId: player.userId,
      username: player.username,
      nickname: player.nickname,
      eloRating: player.eloRating,
      isHost: this.isHost(player.userId),
      isReady: player.isReady,
      connected: player.sockets.size > 0,
    };
  }

  toProgress(player: RoomPlayer): PlayerProgress {
    return {
      userId: player.userId,
      moveCount: player.moveCount,
      status: player.status,
      solveTimeMs: player.solveTimeMs,
    };
  }

  snapshot(): RoomSnapshot {
    const players = [...this.players.values()];
    return {
      roomId: this.roomId,
      roomKind: this.roomKind,
      roomMode: this.roomMode,
      roomCode: this.roomCode,
      cubeType: this.cubeType,
      state: this.state,
      maxPlayers: this.maxPlayers,
      players: players.map((player) => this.toPublicPlayer(player)),
      progress: players.map((player) => this.toProgress(player)),
      spectatorCount: this.spectatorCount,
      // scramble เปิดเผยตั้งแต่ LOADING เป็นต้นไปเท่านั้น (game-rules.md ข้อ 1)
      scramble: this.state === 'WAITING' || this.state === 'MATCHED' ? null : this.scramble,
      serverTs: Date.now(),
      phaseEndsAtTs: this.phaseEndsAtTs,
      serverStartTs: this.serverStartTs,
    };
  }
}
