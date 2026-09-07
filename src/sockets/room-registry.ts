/**
 * ทะเบียนห้องทั้งหมด — อยู่ใน memory ของ process เดียว ไม่มี Redis (ADR-034 ข้อ 1)
 *
 * เก็บสามดัชนีคู่กันเสมอ ห้ามแก้อันใดอันหนึ่งโดยไม่แก้ที่เหลือ:
 *   roomId → Room · roomCode → Room · userId → ห้องที่คนนั้นอยู่ (คนละหนึ่งห้องเท่านั้น)
 */
import type { CubeType, RoomKind, RoomMode } from './types.js';
import { Room } from './room.js';

/** ไม่มีความเคลื่อนไหวเกินเท่านี้ = ยุบห้อง (game-rules.md ข้อ 9) */
export const ROOM_IDLE_TIMEOUT_MS = 30 * 60_000;

/** ตัวอักษรของ room_code — ตัด `0 O 1 I` ที่คนอ่านสับสนทิ้ง (game-rules.md ข้อ 9) */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_MAX_TRIES = 10;

export type Seat = 'player' | 'spectator';

interface Membership {
  roomId: number;
  seat: Seat;
}

const rooms = new Map<number, Room>();
const roomsByCode = new Map<string, Room>();
const membershipByUser = new Map<number, Membership>();

/** ID ชั่วคราวในหน่วยความจำ ไม่ใช่ `match_id` — เริ่มนับใหม่ทุกครั้งที่ process เริ่ม */
let nextRoomId = 1;

function randomRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function generateUniqueRoomCode(): string {
  for (let attempt = 0; attempt < ROOM_CODE_MAX_TRIES; attempt++) {
    const code = randomRoomCode();
    if (!roomsByCode.has(code)) return code;
  }
  // 32^6 ≈ 1,073 ล้านค่า — ชนติดกัน 10 ครั้งแปลว่ามีอะไรผิดปกติจริง ๆ
  throw new Error(`สุ่มรหัสห้องไม่สำเร็จภายใน ${ROOM_CODE_MAX_TRIES} ครั้ง`);
}

export interface CreateRoomInput {
  roomKind: RoomKind;
  roomMode: RoomMode | null;
  cubeType: CubeType;
  maxPlayers: number;
  /** ห้องที่เข้าด้วยรหัส (สร้างเอง) = true · ห้องจับคู่อัตโนมัติ = false */
  withCode: boolean;
}

export function createRoom(input: CreateRoomInput): Room {
  const room = new Room({
    roomId: nextRoomId++,
    roomKind: input.roomKind,
    roomMode: input.roomMode,
    roomCode: input.withCode ? generateUniqueRoomCode() : null,
    cubeType: input.cubeType,
    maxPlayers: input.maxPlayers,
  });

  rooms.set(room.roomId, room);
  if (room.roomCode) roomsByCode.set(room.roomCode, room);
  return room;
}

export function getRoom(roomId: number): Room | null {
  return rooms.get(roomId) ?? null;
}

export function getRoomByCode(roomCode: string): Room | null {
  return roomsByCode.get(roomCode.toUpperCase()) ?? null;
}

/** ห้องที่ผู้ใช้คนนี้อยู่ตอนนี้ (ผู้เล่นหรือผู้ชมก็ได้) */
export function membershipOf(userId: number): (Membership & { room: Room }) | null {
  const membership = membershipByUser.get(userId);
  if (!membership) return null;
  const room = rooms.get(membership.roomId);
  if (!room) {
    membershipByUser.delete(userId);
    return null;
  }
  return { ...membership, room };
}

export function setMembership(userId: number, roomId: number, seat: Seat): void {
  membershipByUser.set(userId, { roomId, seat });
}

export function clearMembership(userId: number): void {
  membershipByUser.delete(userId);
}

/** ลบห้องออกจากทะเบียนทั้งสามดัชนี + ล้างตัวจับเวลาของห้อง (ที่เดียวที่ล้าง — ADR-035 ข้อ 8) */
export function disposeRoom(room: Room): void {
  room.clearTimers();
  rooms.delete(room.roomId);
  if (room.roomCode) roomsByCode.delete(room.roomCode);
  for (const userId of room.players.keys()) {
    if (membershipByUser.get(userId)?.roomId === room.roomId) membershipByUser.delete(userId);
  }
  for (const userId of room.spectators.keys()) {
    if (membershipByUser.get(userId)?.roomId === room.roomId) membershipByUser.delete(userId);
  }
}

/** ห้องที่ร้างเกินกำหนด — ผู้เรียกเป็นคนแจ้ง client แล้วค่อย `disposeRoom` */
export function findExpiredRooms(now = Date.now()): Room[] {
  return [...rooms.values()].filter((room) => now - room.lastActivityTs > ROOM_IDLE_TIMEOUT_MS);
}

/** ไว้ดูตอน debug / เขียนเทส */
export function roomCount(): number {
  return rooms.size;
}

/** ใช้ในเทสเท่านั้น — ล้างทะเบียนทั้งหมด */
export function resetRegistry(): void {
  rooms.clear();
  roomsByCode.clear();
  membershipByUser.clear();
  nextRoomId = 1;
}
