import { FlagVerdict, Prisma, UserStatus, type FlagReason } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { thaiDayRangeOf } from '../lib/week.js';
import { activeRoomCount, onlineUserCount } from '../sockets/presence.js';
import { revokeAllRefreshTokens } from './auth.service.js';
import { writeAuditLog } from './audit.service.js';
import type {
  AdminUsersQueryInput,
  FlaggedQueryInput,
  ReviewFlagInput,
  UpdateUserRatingInput,
  UpdateUserStatusInput,
} from '../schemas/admin.schema.js';
import { CUBE_TYPE_TO_PRISMA, PRISMA_TO_CUBE_TYPE, type ApiCubeType } from '../types/cube.js';
import {
  USER_ROLE_TO_API,
  USER_STATUS_TO_API,
  type ApiUserRole,
  type ApiUserStatus,
} from '../types/api.js';

/**
 * เครื่องมือของแอดมิน (docs/api-contract.md ข้อ 9)
 *
 * **กฎเหล็กของทั้งไฟล์:** ทุกฟังก์ชันที่เปลี่ยนข้อมูลต้องเขียน `AdminAuditLog`
 * ในทรานแซกชันเดียวกัน (ADR-017) — สิทธิ์ระงับบัญชี/แก้คะแนนคือสิทธิ์ที่แก้ผลการแข่งของคนอื่นได้ตรง ๆ
 */

// ---------------------------------------------------------------- แดชบอร์ด

const DASHBOARD_DAYS = 7;

export interface DashboardDto {
  activeRooms: number;
  onlineUsers: number;
  totalUsers: number;
  matchesToday: number;
  matchesLast7Days: number[];
  pendingReports: number;
  flaggedMatches: number;
  byCubeType: Record<ApiCubeType, number>;
}

export async function getDashboard(now = new Date()): Promise<DashboardDto> {
  const today = thaiDayRangeOf(now);
  const weekStart = thaiDayRangeOf(now, DASHBOARD_DAYS - 1).start;

  // `countTodayByCubeType` เป็น query สองตัวที่ยิงเองข้างใน จึงอยู่นอก `$transaction`
  // (`$transaction([...])` รับได้เฉพาะ PrismaPromise ไม่ใช่ Promise ธรรมดา)
  const [[totalUsers, pendingReports, flaggedMatches, duelDays, multiDays], byType] =
    await Promise.all([
      prisma.$transaction([
        prisma.user.count({ where: { deletedAt: null } }),
        prisma.report.count({ where: { reportStatus: 'PENDING' } }),
        // "ยังไม่ได้ตรวจ" = verdict ยังว่าง — ตัวเลขนี้คือคิวงานของแอดมิน ไม่ใช่ยอดสะสมทั้งหมด
        prisma.matchFlag.count({ where: { verdict: null } }),
        prisma.match.findMany({
          where: { startedAt: { gte: weekStart, lt: today.end } },
          select: { startedAt: true },
        }),
        prisma.multiplayerMatch.findMany({
          where: { startedAt: { gte: weekStart, lt: today.end } },
          select: { startedAt: true },
        }),
      ]),
      countTodayByCubeType(today.start, today.end),
    ]);

  // นับ 7 ช่องในหน่วยความจำ — ข้อมูลชุดเดียวกันถูกใช้ทั้งกราฟและตัวเลข "วันนี้"
  // ยิง 7 query แยกกันคือ 7 รอบไป-กลับ DB เพื่อผลรวมชุดเดียว
  const buckets = new Array<number>(DASHBOARD_DAYS).fill(0);
  const dayEdges = Array.from({ length: DASHBOARD_DAYS }, (_, i) =>
    thaiDayRangeOf(now, DASHBOARD_DAYS - 1 - i),
  );
  for (const row of [...duelDays, ...multiDays]) {
    const index = dayEdges.findIndex(
      (range) => row.startedAt >= range.start && row.startedAt < range.end,
    );
    if (index >= 0) buckets[index]! += 1;
  }

  return {
    activeRooms: activeRoomCount(),
    onlineUsers: onlineUserCount(),
    totalUsers,
    matchesToday: buckets[DASHBOARD_DAYS - 1]!,
    matchesLast7Days: buckets,
    pendingReports,
    flaggedMatches,
    byCubeType: byType,
  };
}

/** แมตช์ของ "วันนี้" แยกตามประเภทรูบิค — รวมทั้งสองระบบแมตช์ */
async function countTodayByCubeType(start: Date, end: Date): Promise<Record<ApiCubeType, number>> {
  const window = { startedAt: { gte: start, lt: end } };
  const [duel, multi] = await Promise.all([
    prisma.match.groupBy({ by: ['cubeType'], where: window, _count: { _all: true } }),
    prisma.multiplayerMatch.groupBy({ by: ['cubeType'], where: window, _count: { _all: true } }),
  ]);

  const result: Record<ApiCubeType, number> = {
    '2x2x2': 0,
    '3x3x3': 0,
    pyraminx: 0,
    pyramorphix: 0,
  };
  for (const row of [...duel, ...multi]) {
    result[PRISMA_TO_CUBE_TYPE[row.cubeType]] += row._count._all;
  }
  return result;
}

// ---------------------------------------------------------------- จัดการบัญชี

export interface AdminUserDto {
  userId: number;
  username: string;
  nickname: string | null;
  email: string;
  role: ApiUserRole;
  status: ApiUserStatus;
  suspendedUntil: string | null;
  deletedAt: string | null;
  createdAt: string;
  reportCount: number;
  flagCount: number;
}

/** include ชุดเดียวที่ทั้งหน้ารายการและการอ่านทีละคนใช้ — รูปของแถวจะได้ตรงกันเสมอ */
const adminUserInclude = {
  _count: { select: { reportsAgainst: true, flags: true } },
} satisfies Prisma.UserInclude;

type AdminUserRow = Prisma.UserGetPayload<{ include: typeof adminUserInclude }>;

function toAdminUserDto(user: AdminUserRow): AdminUserDto {
  return {
    userId: user.userId,
    username: user.username,
    nickname: user.nickname,
    // endpoint ของแอดมินเท่านั้นที่ส่ง email ออกได้ (api-contract.md ข้อ 11)
    email: user.email,
    role: USER_ROLE_TO_API[user.role],
    status: USER_STATUS_TO_API[user.status],
    suspendedUntil: user.suspendedUntil?.toISOString() ?? null,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    reportCount: user._count.reportsAgainst,
    flagCount: user._count.flags,
  };
}

export async function listUsers(q: AdminUsersQueryInput) {
  const where: Prisma.UserWhereInput = {};

  if (q.status === 'deleted') where.deletedAt = { not: null };
  else if (q.status === 'active') where.AND = [{ status: UserStatus.ACTIVE }, { deletedAt: null }];
  else if (q.status === 'suspended')
    where.AND = [{ status: UserStatus.SUSPENDED }, { deletedAt: null }];

  if (q.q) {
    where.OR = [
      { username: { contains: q.q, mode: 'insensitive' } },
      { email: { contains: q.q, mode: 'insensitive' } },
      { nickname: { contains: q.q, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: adminUserInclude,
    }),
  ]);

  return {
    data: rows.map(toAdminUserDto),
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.limit)),
    },
  };
}

/**
 * ระงับ / ปลดระงับบัญชี
 *
 * ระงับแล้วต้อง **เพิกถอน refresh token ทุกอุปกรณ์** ไม่งั้นคนที่ถูกระงับยังเล่นต่อได้
 * จนกว่า token จะหมดอายุ (ADR-013 · ADR-023)
 */
export async function setUserStatus(
  adminId: number,
  userId: number,
  input: UpdateUserStatusInput,
): Promise<AdminUserDto> {
  if (userId === adminId) {
    throw errors.validation('ระงับบัญชีตัวเองไม่ได้', { status: 'ระงับบัญชีตัวเองไม่ได้' });
  }

  const user = await prisma.user.findUnique({ where: { userId } });
  if (!user) throw errors.notFound('ไม่พบผู้ใช้รายนี้');
  if (user.deletedAt) {
    throw errors.validation('บัญชีนี้ถูกลบไปแล้ว แก้สถานะไม่ได้', {
      status: 'บัญชีนี้ถูกลบไปแล้ว',
    });
  }

  const suspending = input.status === 'suspended';

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { userId },
      data: {
        status: suspending ? UserStatus.SUSPENDED : UserStatus.ACTIVE,
        // ปลดระงับต้องล้างวันสิ้นสุดทิ้งเสมอ ไม่งั้นเหลือค่าเก่าค้างไว้ให้สับสน
        suspendedUntil: suspending ? (input.suspendedUntil ?? null) : null,
      },
    });
    if (suspending) await revokeAllRefreshTokens(userId, tx);

    await writeAuditLog(tx, {
      adminId,
      action: suspending ? 'suspend_user' : 'unsuspend_user',
      targetUserId: userId,
      detail: {
        before: {
          status: USER_STATUS_TO_API[user.status],
          until: user.suspendedUntil?.toISOString() ?? null,
        },
        after: { status: input.status, until: input.suspendedUntil?.toISOString() ?? null },
        note: input.note ?? null,
      },
    });
  });

  return readAdminUser(userId);
}

/**
 * แก้คะแนน Elo ของประเภทเดียว (api-contract.md ข้อ 9)
 *
 * **ไม่แตะ** `wins`/`losses`/`best_time` และไม่ย้อนแก้ `elo_after` ของแมตช์เก่า — ADR-050 ข้อ 4
 */
export async function setUserRating(
  adminId: number,
  userId: number,
  input: UpdateUserRatingInput,
): Promise<{ userId: number; cubeType: ApiCubeType; before: number; after: number }> {
  const cubeType = CUBE_TYPE_TO_PRISMA[input.cubeType];
  const rating = await prisma.rating.findUnique({
    where: { userId_cubeType: { userId, cubeType } },
  });
  // ผู้ใช้ทุกคนมี Rating ครบ 4 แถวตั้งแต่สมัคร → ไม่เจอ = ไม่มีผู้ใช้คนนี้ (หรือข้อมูลพัง)
  if (!rating) throw errors.notFound('ไม่พบคะแนนของผู้ใช้รายนี้');

  await prisma.$transaction(async (tx) => {
    await tx.rating.update({
      where: { userId_cubeType: { userId, cubeType } },
      data: { eloRating: input.eloRating },
    });
    await writeAuditLog(tx, {
      adminId,
      action: 'edit_rating',
      targetUserId: userId,
      detail: {
        cubeType: input.cubeType,
        before: rating.eloRating,
        after: input.eloRating,
        note: input.note ?? null,
      },
    });
  });

  return {
    userId,
    cubeType: input.cubeType,
    before: rating.eloRating,
    after: input.eloRating,
  };
}

async function readAdminUser(userId: number): Promise<AdminUserDto> {
  const user = await prisma.user.findUnique({ where: { userId }, include: adminUserInclude });
  if (!user) throw errors.internal('อ่านข้อมูลผู้ใช้กลับมาไม่ได้');
  return toAdminUserDto(user);
}

// ---------------------------------------------------------------- แมตช์ที่ถูก flag

const FLAG_REASON_TO_API: Record<FlagReason, string> = {
  IMPOSSIBLE_TIME: 'impossible_time',
  LOW_MOVE_COUNT: 'low_move_count',
  HIGH_TPS: 'high_tps',
  MOVE_GAP: 'move_gap',
  WIN_STREAK: 'win_streak',
};

const VERDICT_TO_API: Record<FlagVerdict, string> = {
  CLEAN: 'clean',
  CHEATING: 'cheating',
  INCONCLUSIVE: 'inconclusive',
};

const VERDICT_TO_DB: Record<ReviewFlagInput['verdict'], FlagVerdict> = {
  clean: FlagVerdict.CLEAN,
  cheating: FlagVerdict.CHEATING,
  inconclusive: FlagVerdict.INCONCLUSIVE,
};

export interface FlagDto {
  flagId: number;
  flagReason: string;
  detail: unknown;
  user: { userId: number; username: string; nickname: string | null };
  matchId: number | null;
  multiplayerMatchId: number | null;
  hasMoveLog: boolean;
  moveLogLength: number;
  verdict: string | null;
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
}

/** เฉพาะตอนเปิดดูทีละใบเท่านั้นที่ส่ง move stream เต็มออกไป (ADR-050 ข้อ 5) */
export interface FlagDetailDto extends FlagDto {
  moveLog: unknown;
}

const flagInclude = {
  user: { select: { userId: true, username: true, nickname: true } },
} satisfies Prisma.MatchFlagInclude;

type FlagRow = Prisma.MatchFlagGetPayload<{ include: typeof flagInclude }>;

function toFlagDto(row: FlagRow): FlagDto {
  const moveLog = Array.isArray(row.moveLog) ? row.moveLog : null;
  return {
    flagId: row.flagId,
    flagReason: FLAG_REASON_TO_API[row.flagReason],
    detail: row.detail,
    user: row.user,
    matchId: row.matchId,
    multiplayerMatchId: row.multiplayerMatchId,
    hasMoveLog: moveLog !== null,
    moveLogLength: moveLog?.length ?? 0,
    verdict: row.verdict ? VERDICT_TO_API[row.verdict] : null,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listFlags(q: FlaggedQueryInput) {
  const where: Prisma.MatchFlagWhereInput =
    q.verdict === 'all'
      ? {}
      : q.verdict === 'pending'
        ? { verdict: null }
        : { verdict: VERDICT_TO_DB[q.verdict] };

  const [total, rows] = await prisma.$transaction([
    prisma.matchFlag.count({ where }),
    prisma.matchFlag.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: flagInclude,
    }),
  ]);

  return {
    // หน้ารายการไม่ส่ง moveLog — solve เดียวมีได้เป็นร้อย move (ADR-050 ข้อ 5)
    data: rows.map(toFlagDto),
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.limit)),
    },
  };
}

export async function getFlag(flagId: number): Promise<FlagDetailDto> {
  const row = await prisma.matchFlag.findUnique({ where: { flagId }, include: flagInclude });
  if (!row) throw errors.notFound('ไม่พบ flag ที่ต้องการ');
  return { ...toFlagDto(row), moveLog: row.moveLog };
}

/**
 * ตัดสิน flag — **ไม่มีผลกับบัญชีของผู้เล่น**
 * จะระงับต้องสั่งที่ `PATCH /admin/users/:userId/status` อีกครั้ง (ADR-050 ข้อ 5)
 */
export async function reviewFlag(
  adminId: number,
  flagId: number,
  input: ReviewFlagInput,
): Promise<FlagDto> {
  const current = await prisma.matchFlag.findUnique({ where: { flagId } });
  if (!current) throw errors.notFound('ไม่พบ flag ที่ต้องการ');

  await prisma.$transaction(async (tx) => {
    await tx.matchFlag.update({
      where: { flagId },
      data: {
        verdict: VERDICT_TO_DB[input.verdict],
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });
    await writeAuditLog(tx, {
      adminId,
      action: 'review_flag',
      targetUserId: current.userId,
      detail: {
        flagId,
        reason: FLAG_REASON_TO_API[current.flagReason],
        before: current.verdict ? VERDICT_TO_API[current.verdict] : null,
        after: input.verdict,
        note: input.note ?? null,
      },
    });
  });

  const updated = await prisma.matchFlag.findUnique({ where: { flagId }, include: flagInclude });
  if (!updated) throw errors.internal('อ่าน flag กลับมาไม่ได้');
  return toFlagDto(updated);
}
