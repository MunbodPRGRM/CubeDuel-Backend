/**
 * State machine ของแมตช์ — `LOADING → COUNTDOWN → INSPECTION → SOLVING → [FINAL_COUNTDOWN] → FINISHED`
 *
 * กติกาทั้งหมดมาจาก `docs/game-rules.md` ข้อ 1–7 + 10 · รายละเอียดที่เอกสารไม่ได้ระบุอยู่ใน ADR-035
 *
 * หลักการที่ห้ามละเมิด (CLAUDE.md ข้อ 8):
 *   - state เป็นของ server · client แค่สะท้อนตาม
 *   - เวลาตัดสินใช้ของ server เท่านั้น ห้ามเชื่อ `clientTs`
 *   - ส่ง "เวลาสิ้นสุด" (`endsAtTs`) ไม่ใช่ "เหลืออีกกี่วินาที"
 *   - ตัวจับเวลาทุกตัวต้องอยู่บน `Room` เพื่อให้ `disposeRoom()` ล้างได้ที่เดียว (ADR-035 ข้อ 8)
 */
import {
  COUNTDOWN_MS,
  DISCONNECT_GRACE_MS,
  FINAL_COUNTDOWN_MS,
  HARD_TIMEOUT_MS,
  INSPECTION_MS,
  LOADING_TIMEOUT_MS,
  MAX_LATENCY_COMPENSATION_MS,
  PROGRESS_INTERVAL_MS,
} from '../constants.js';
import { replaySolve } from '../lib/cube-state.js';
import { newRating } from '../lib/elo.js';
import { isAllowedMove } from '../lib/moves.js';
import { generateScrambles } from '../services/scramble.service.js';
import {
  assignRanks,
  findWinnerId,
  saveMatch,
  type MatchPlayerOutcome,
} from '../services/match.service.js';
import type { TypedServer, TypedSocket } from './ack.js';
import { socketErrors } from './errors.js';
import type { Room, RoomPlayer } from './room.js';
import { abortRoom, broadcastState, emitToRoom, removePlayerFromRoom } from './room-service.js';
import {
  playerRoomName,
  spectatorRoomName,
  type DnfReason,
  type MatchResult,
  type MatchResultEntry,
  type SolveMovePayload,
  type SolveSolvedPayload,
  type SolveSolvedResult,
} from './types.js';

/** ห้องที่ปรับ Elo จริง — ห้องสร้างเองไม่ปรับ (CLAUDE.md ข้อ 7) */
function isRatedRoom(room: Room): boolean {
  return room.roomKind === 'competitive';
}

/** ผู้เล่นที่ยังไม่จบ (ยังหมุนอยู่) */
function stillSolving(room: Room): RoomPlayer[] {
  return room.stillSolving();
}

// ---------------------------------------------------------------- เริ่มแมตช์

/**
 * `room:start` — host กดเริ่ม (ทั้งรอบแรกและ "เล่นอีกครั้ง" ในห้องเดิม — ADR-035 ข้อ 3)
 * เงื่อนไข: ผู้เล่นครบตามจำนวน + ทุกคนยังต่ออยู่ (ADR-035 ข้อ 2)
 */
export async function startMatch(io: TypedServer, room: Room, userId: number): Promise<void> {
  if (!room.isHost(userId)) throw socketErrors.notHost('เฉพาะหัวห้องเท่านั้นที่กดเริ่มได้');
  if (room.state !== 'WAITING' && room.state !== 'FINISHED') {
    throw socketErrors.invalidState('ห้องนี้กำลังแข่งอยู่');
  }
  if (!room.isFull) throw socketErrors.invalidState('ต้องมีผู้เล่นครบก่อนจึงจะเริ่มได้');
  if ([...room.players.values()].some((player) => player.sockets.size === 0)) {
    throw socketErrors.invalidState('มีผู้เล่นหลุดการเชื่อมต่ออยู่ รอให้กลับมาก่อน');
  }

  room.resetForNewRound();

  // 📕 server เป็นคน generate เท่านั้น ห้ามให้ client เลือก scramble ที่ง่ายให้ตัวเอง
  const [scramble] = await generateScrambles(room.cubeType, 1);
  if (!scramble) throw socketErrors.internal('สร้าง scramble ไม่สำเร็จ');

  // ระหว่าง await ห้องอาจถูกยุบไปแล้ว (คนออกหมด / โดนสวีปเปอร์เก็บ)
  if (room.state !== 'WAITING' && room.state !== 'FINISHED') return;

  room.scramble = scramble;
  room.state = 'LOADING';
  room.phaseEndsAtTs = Date.now() + LOADING_TIMEOUT_MS;
  room.touch();

  emitToRoom(io, room, 'match:loading', {
    scramble,
    cubeType: room.cubeType,
    deadlineTs: room.phaseEndsAtTs,
  });
  broadcastState(io, room);

  // ครบเวลาแล้วไปต่อเลย ไม่ว่าจะมีคนยังโหลดไม่เสร็จหรือไม่ (game-rules.md ข้อ 1)
  room.phaseTimer = setTimeout(() => beginCountdown(io, room), LOADING_TIMEOUT_MS);
}

/** `solve:ready` — client แจ้งว่าโหลดโมเดล 3D + ใส่ scramble ลงคิวบ์เสร็จแล้ว */
export function markLoaded(io: TypedServer, room: Room, userId: number): void {
  if (room.state !== 'LOADING') throw socketErrors.invalidState('ยังไม่ถึงช่วงโหลดคิวบ์');
  const player = room.players.get(userId);
  if (!player) throw socketErrors.invalidState('ผู้ชมไม่ต้องส่ง solve:ready');

  player.loaded = true;
  room.touch();
  broadcastState(io, room);

  if ([...room.players.values()].every((entry) => entry.loaded)) {
    room.clearPhaseTimer();
    beginCountdown(io, room);
  }
}

function beginCountdown(io: TypedServer, room: Room): void {
  if (room.state !== 'LOADING') return;
  room.clearPhaseTimer();

  const startsAtTs = Date.now();
  room.state = 'COUNTDOWN';
  room.phaseEndsAtTs = startsAtTs + COUNTDOWN_MS;

  emitToRoom(io, room, 'match:countdown', { startsAtTs, durationMs: COUNTDOWN_MS });
  broadcastState(io, room);
  room.phaseTimer = setTimeout(() => beginInspection(io, room), COUNTDOWN_MS);
}

function beginInspection(io: TypedServer, room: Room): void {
  if (room.state !== 'COUNTDOWN') return;
  room.clearPhaseTimer();

  const endsAtTs = Date.now() + INSPECTION_MS;
  room.state = 'INSPECTION';
  room.phaseEndsAtTs = endsAtTs;

  emitToRoom(io, room, 'match:inspection_started', { endsAtTs, durationMs: INSPECTION_MS });
  broadcastState(io, room);
  // ห้องแข่ง **กดข้ามไม่ได้** ทุกคนต้องเริ่มพร้อมกัน (ข้ามได้เฉพาะห้องฝึกซ้อม — ADR-032)
  room.phaseTimer = setTimeout(() => beginSolving(io, room), INSPECTION_MS);
}

function beginSolving(io: TypedServer, room: Room): void {
  if (room.state !== 'INSPECTION') return;
  room.clearPhaseTimer();

  const serverStartTs = Date.now();
  room.state = 'SOLVING';
  room.serverStartTs = serverStartTs;
  room.phaseEndsAtTs = null;

  emitToRoom(io, room, 'match:started', { serverStartTs });
  broadcastState(io, room);

  // กันห้องค้างถาวรถ้าไม่มีใครแก้เสร็จเลย (game-rules.md ข้อ 4)
  room.hardTimeoutTimer = setTimeout(
    () => finishMatch(io, room, 'timeout'),
    HARD_TIMEOUT_MS[room.cubeType],
  );
  room.progressTimer = setInterval(() => broadcastProgress(io, room), PROGRESS_INTERVAL_MS);
}

/** `opponent:progress` — throttle ไว้ที่ 500 ms อย่าส่งทุก move (socket-events.md ข้อ 11) */
function broadcastProgress(io: TypedServer, room: Room): void {
  if (room.serverStartTs === null) return;
  const elapsedMs = Date.now() - room.serverStartTs;
  for (const player of stillSolving(room)) {
    emitToRoom(io, room, 'opponent:progress', {
      userId: player.userId,
      moveCount: player.moveCount,
      elapsedMs,
    });
  }
}

// ---------------------------------------------------------------- ระหว่างแก้

/** ผู้เล่นในห้องนี้ที่ส่ง event มา — ผู้ชมส่ง `solve:*` ไม่ได้ */
function requirePlayer(room: Room, userId: number): RoomPlayer {
  const player = room.players.get(userId);
  if (!player) throw socketErrors.invalidState('ผู้ชมส่งคำสั่งของผู้เล่นไม่ได้');
  return player;
}

/**
 * `solve:move` — ไม่มี ack เพื่อความลื่น
 * move ที่ผิดถูก **ทิ้ง** ไม่เข้า stream และไม่นับ move (ไม่ใช่ DNF — ADR-035 ข้อ 1)
 */
export function handleMove(
  io: TypedServer,
  socket: TypedSocket,
  room: Room,
  payload: SolveMovePayload,
): void {
  const player = requirePlayer(room, socket.data.userId);

  if (room.state === 'INSPECTION') {
    throw socketErrors.moveDuringInspection('ช่วงตรวจสอบหมุนหน้าคิวบ์ไม่ได้ (หมุนกล้องดูได้)');
  }
  if (room.state !== 'SOLVING' && room.state !== 'FINAL_COUNTDOWN') {
    throw socketErrors.invalidState('ยังไม่ถึงเวลาหมุนคิวบ์');
  }
  if (player.status !== 'solving') throw socketErrors.invalidState('รอบนี้ของคุณจบไปแล้ว');
  if (payload.seq !== player.moves.length + 1) {
    throw socketErrors.seqMismatch(
      `คาดว่าจะได้ seq ${player.moves.length + 1} แต่ได้ ${payload.seq}`,
    );
  }
  if (!isAllowedMove(room.cubeType, payload.move)) {
    throw socketErrors.invalidMove(`ท่า "${payload.move}" ใช้กับ ${room.cubeType} ไม่ได้`);
  }

  const serverTs = Date.now();
  // ⚠️ ใช้เวลาที่ server ได้รับเท่านั้น `clientTs` ที่ส่งมาไม่เอามาคำนวณอะไรทั้งสิ้น
  player.moves.push({
    seq: payload.seq,
    move: payload.move,
    ms: serverTs - (room.serverStartTs ?? serverTs),
  });
  player.moveCount = player.moves.length;
  room.touch();

  // ส่งให้ทุกคนในห้องยกเว้น socket ที่ส่งมาเอง (แท็บอื่นของคนเดียวกันยังได้ ไว้ให้ภาพตรงกัน)
  io.to(playerRoomName(room.roomId))
    .to(spectatorRoomName(room.roomId))
    .except(socket.id)
    .emit('opponent:move', {
      userId: player.userId,
      seq: payload.seq,
      move: payload.move,
      serverTs,
    });
}

/**
 * `solve:solved` — server **replay move stream เองทั้งเส้น** แล้วตัดสิน
 * ไม่ผ่าน = ตอบ `E_NOT_SOLVED` เฉย ๆ นาฬิกาเดินต่อ ผู้เล่นแก้ต่อได้ (ADR-035 ข้อ 1)
 */
export async function handleSolved(
  io: TypedServer,
  socket: TypedSocket,
  room: Room,
  payload: SolveSolvedPayload,
): Promise<SolveSolvedResult> {
  const player = requirePlayer(room, socket.data.userId);
  const receivedTs = Date.now();

  if (room.state !== 'SOLVING' && room.state !== 'FINAL_COUNTDOWN') {
    throw socketErrors.invalidState('ยังไม่ถึงเวลาจับเวลา หรือแมตช์จบไปแล้ว');
  }
  if (player.status !== 'solving') throw socketErrors.invalidState('รอบนี้ของคุณจบไปแล้ว');
  if (payload.seq !== player.moves.length) {
    throw socketErrors.seqMismatch(
      `server มี move ถึง seq ${player.moves.length} แต่แจ้งว่าเสร็จที่ ${payload.seq}`,
    );
  }
  if (room.scramble === null || room.serverStartTs === null) {
    throw socketErrors.invalidState('ห้องนี้ยังไม่ได้เริ่มจับเวลา');
  }

  const replay = await replaySolve(
    room.cubeType,
    room.scramble,
    player.moves.map((entry) => entry.move),
  );
  if (replay.invalidMove !== null) {
    throw socketErrors.invalidMove(`move stream มีท่าที่ใช้ไม่ได้: ${replay.invalidMove}`);
  }
  if (!replay.solved) throw socketErrors.notSolved();

  // ระหว่าง await แมตช์อาจจบไปแล้ว (คู่แข่งแก้เสร็จแล้วหมดเวลานับถอยหลังพอดี)
  if (room.state !== 'SOLVING' && room.state !== 'FINAL_COUNTDOWN') {
    throw socketErrors.invalidState('แมตช์จบไปแล้ว');
  }

  // solveTimeMs = serverReceivedTs - serverStartTs - min(rtt / 2, 150)  (game-rules.md ข้อ 3)
  const compensation = Math.min((socket.data.rttMs ?? 0) / 2, MAX_LATENCY_COMPENSATION_MS);
  const solveTimeMs = Math.max(0, Math.round(receivedTs - room.serverStartTs - compensation));

  player.status = 'solved';
  player.solveTimeMs = solveTimeMs;
  player.moveCount = player.moves.length;
  room.touch();

  const rankNo = assignRanks([...room.players.values()]).get(player.userId) ?? 1;
  player.rankNo = rankNo;

  emitToRoom(io, room, 'player:solved', {
    userId: player.userId,
    solveTimeMs,
    moveCount: player.moveCount,
    rankNo,
  });

  if (stillSolving(room).length === 0) {
    void finishMatch(io, room, 'all_done');
  } else if (room.state === 'SOLVING') {
    beginFinalCountdown(io, room, player.userId);
  } else {
    broadcastState(io, room);
  }

  return { solveTimeMs, rankNo };
}

/** คนแรกแก้เสร็จ → คนที่เหลือมีเวลาอีก 10 วินาที (game-rules.md ข้อ 4) */
function beginFinalCountdown(io: TypedServer, room: Room, firstSolverUserId: number): void {
  room.clearPhaseTimer();
  const endsAtTs = Date.now() + FINAL_COUNTDOWN_MS;
  room.state = 'FINAL_COUNTDOWN';
  room.phaseEndsAtTs = endsAtTs;

  emitToRoom(io, room, 'match:final_countdown', {
    firstSolverUserId,
    endsAtTs,
    durationMs: FINAL_COUNTDOWN_MS,
  });
  broadcastState(io, room);
  room.phaseTimer = setTimeout(
    () => void finishMatch(io, room, 'final_countdown'),
    FINAL_COUNTDOWN_MS,
  );
}

/** `solve:surrender` — ยอมแพ้ = DNF (game-rules.md ข้อ 5) */
export function handleSurrender(io: TypedServer, room: Room, userId: number): void {
  const player = requirePlayer(room, userId);
  if (room.state !== 'SOLVING' && room.state !== 'FINAL_COUNTDOWN') {
    throw socketErrors.invalidState('ยอมแพ้ได้เฉพาะระหว่างแข่ง');
  }
  if (player.status !== 'solving') throw socketErrors.invalidState('รอบนี้ของคุณจบไปแล้ว');

  markDnf(io, room, player, 'surrender');
  if (stillSolving(room).length === 0) void finishMatch(io, room, 'all_done');
  else broadcastState(io, room);
}

function markDnf(io: TypedServer, room: Room, player: RoomPlayer, reason: DnfReason): void {
  player.status = reason === 'surrender' ? 'surrendered' : 'dnf';
  player.solveTimeMs = null;
  room.touch();
  emitToRoom(io, room, 'player:dnf', { userId: player.userId, reason });
}

// ---------------------------------------------------------------- หลุดการเชื่อมต่อ

/**
 * socket ตัวสุดท้ายของผู้เล่นหลุด — เริ่มนับ grace 30 วินาที (game-rules.md ข้อ 6)
 * เรียกจากตัวจัดการ `disconnect` เท่านั้น (ไม่ได้เรียกจาก `room-service` เพื่อไม่ให้ import วน)
 */
export function beginDisconnectGrace(io: TypedServer, room: Room, userId: number): void {
  const player = room.players.get(userId);
  if (!player || room.state === 'ABORTED') return;
  if (room.graceTimers.has(userId)) return;

  const graceEndsAtTs = Date.now() + DISCONNECT_GRACE_MS;
  emitToRoom(io, room, 'player:disconnected', { userId, graceEndsAtTs });
  broadcastState(io, room);

  room.graceTimers.set(
    userId,
    setTimeout(() => {
      room.graceTimers.delete(userId);
      if (!room.players.has(userId) || player.sockets.size > 0) return;

      switch (room.state) {
        case 'WAITING':
        case 'FINISHED':
          // ยังไม่เริ่ม หรือแมตช์จบไปแล้ว → ถอดออกจากห้องเหมือนกดออกเอง (game-rules.md ข้อ 6)
          // ผลที่บันทึกไปแล้วไม่ถูกแตะ แค่ไม่ให้ที่นั่งค้างจนคนที่เหลือเริ่มรอบใหม่ไม่ได้
          removePlayerFromRoom(io, room, userId, 'disconnected');
          return;
        case 'LOADING':
        case 'COUNTDOWN':
        case 'INSPECTION':
          // ยังไม่เริ่มจับเวลา → ยุบห้อง ไม่บันทึก DB ไม่ปรับ Elo
          abortRoom(
            io,
            room,
            'player_left',
            'ผู้เล่นหลุดการเชื่อมต่อนานเกินไป ห้องนี้จึงถูกยกเลิก',
          );
          return;
        case 'SOLVING':
        case 'FINAL_COUNTDOWN':
          // เริ่มจับเวลาแล้ว → DNF และปรับ Elo ตามปกติ (นาฬิกาไม่เคยหยุดเดิน)
          if (player.status === 'solving') markDnf(io, room, player, 'disconnect');
          if (stillSolving(room).length === 0) void finishMatch(io, room, 'all_done');
          else broadcastState(io, room);
          return;
        default:
          return;
      }
    }, DISCONNECT_GRACE_MS),
  );
}

// ---------------------------------------------------------------- จบแมตช์

export type FinishCause = 'all_done' | 'final_countdown' | 'timeout';

/** สร้างผลของผู้เล่นหนึ่งคนสำหรับบันทึก DB + ส่งกลับ client */
function toOutcome(
  player: RoomPlayer,
  rankNo: number,
  eloChange: number | null,
): MatchPlayerOutcome {
  return {
    userId: player.userId,
    username: player.username,
    seatNo: player.seatNo,
    status: player.status,
    solveTimeMs: player.status === 'solved' ? player.solveTimeMs : null,
    moveCount: player.moveCount,
    moveTimestampsMs: player.moves.map((entry) => entry.ms),
    moveLog: player.moves,
    eloBefore: player.eloRating,
    eloChange,
    rankNo,
  };
}

/** Elo 1v1 (K = 32) — ห้องสร้างเองไม่ปรับคะแนน คืน `null` ทั้งคู่ */
function eloChanges(room: Room, ranks: Map<number, number>): Map<number, number | null> {
  const players = [...room.players.values()];
  const changes = new Map<number, number | null>();
  if (!isRatedRoom(room) || players.length !== 2) {
    for (const player of players) changes.set(player.userId, null);
    return changes;
  }

  const [first, second] = players;
  const pairs: [RoomPlayer, RoomPlayer][] = [
    [first!, second!],
    [second!, first!],
  ];
  for (const [self, opponent] of pairs) {
    const selfRank = ranks.get(self.userId)!;
    const opponentRank = ranks.get(opponent.userId)!;
    // DNF ทั้งคู่ = อันดับเท่ากัน = เสมอ (S = 0.5 ทั้งคู่ — ADR-007)
    const score = selfRank === opponentRank ? 0.5 : selfRank < opponentRank ? 1 : 0;
    changes.set(self.userId, newRating(self.eloRating, opponent.eloRating, score) - self.eloRating);
  }
  return changes;
}

/**
 * ล็อกผล → บันทึก DB → ส่ง `match:finished`
 * เรียกซ้ำได้ปลอดภัย (guard ด้วย state) — มีหลายทางที่ทำให้แมตช์จบพร้อมกันได้
 */
export async function finishMatch(io: TypedServer, room: Room, cause: FinishCause): Promise<void> {
  if (room.state !== 'SOLVING' && room.state !== 'FINAL_COUNTDOWN') return;

  room.clearTimers();
  room.state = 'FINISHED';
  room.phaseEndsAtTs = null;

  // คนที่ยังแก้ไม่เสร็จตอนหมดเวลา = DNF (game-rules.md ข้อ 4)
  for (const player of stillSolving(room)) {
    markDnf(io, room, player, 'timeout');
  }

  const players = [...room.players.values()];
  const ranks = assignRanks(players);
  const changes = eloChanges(room, ranks);
  for (const player of players) player.rankNo = ranks.get(player.userId) ?? null;

  const outcomes = players.map((player) =>
    toOutcome(player, ranks.get(player.userId) ?? 1, changes.get(player.userId) ?? null),
  );
  const winnerId = findWinnerId(
    outcomes.map((entry) => ({
      userId: entry.userId,
      rankNo: entry.rankNo,
      status: entry.status,
    })),
  );

  const finishedAtTs = Date.now();
  let matchId: number | null = null;

  // ห้องฝึกซ้อมไม่บันทึก · ห้อง 1v1 (custom/competitive) บันทึกลงตาราง Match
  if (room.scramble !== null && outcomes.length === 2) {
    try {
      matchId = await saveMatch({
        roomType: isRatedRoom(room) ? 'COMPETITIVE' : 'CUSTOM',
        cubeType: room.cubeType,
        scramble: room.scramble,
        roomCode: room.roomCode,
        spectatorCount: room.peakSpectatorCount,
        startedAtTs: room.serverStartTs ?? finishedAtTs,
        finishedAtTs,
        winnerId,
        players: outcomes,
      });
      // Elo ที่ปรับแล้วต้องสะท้อนกลับเข้าห้องด้วย เผื่อเล่นรอบใหม่ในห้องเดิม
      for (const player of players) {
        const change = changes.get(player.userId);
        if (change) player.eloRating += change;
      }
    } catch (error) {
      // บันทึกไม่ได้ก็ยังต้องบอกผลให้ผู้เล่นเห็น ไม่ใช่ค้างจอไว้เฉย ๆ
      console.error('[socket] บันทึกผลแมตช์ไม่สำเร็จ', error);
    }
  }

  const results: MatchResultEntry[] = outcomes
    .map((entry) => ({
      userId: entry.userId,
      username: entry.username,
      solveTimeMs: entry.solveTimeMs,
      moveCount: entry.moveCount,
      rankNo: entry.rankNo,
      eloBefore: entry.eloChange === null ? null : entry.eloBefore,
      eloAfter: entry.eloChange === null ? null : entry.eloBefore + entry.eloChange,
      eloChange: entry.eloChange,
    }))
    .sort((a, b) => a.rankNo - b.rankNo);

  const payload: MatchResult = {
    matchId,
    roomKind: room.roomKind,
    cubeType: room.cubeType,
    scramble: room.scramble ?? '',
    ratingApplied: isRatedRoom(room),
    results,
    finishedAtTs,
  };

  if (cause === 'timeout') {
    console.log(`[socket] ห้อง ${room.roomId} จบด้วย hard timeout (ไม่มีใครแก้เสร็จ)`);
  }

  emitToRoom(io, room, 'match:finished', payload);
  broadcastState(io, room);

  // คนที่หลุดไปตั้งแต่ระหว่างแข่ง: `clearTimers()` ข้างบนล้าง grace ของเขาไปด้วย
  // ตั้งใหม่เพื่อไม่ให้ที่นั่งค้างจนคนที่เหลือกด "เล่นอีกครั้ง" ไม่ได้
  for (const player of room.players.values()) {
    if (player.sockets.size === 0) beginDisconnectGrace(io, room, player.userId);
  }
}
