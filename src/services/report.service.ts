import {
  Prisma,
  ReportAction,
  ReportStatus,
  UserStatus,
  type Report,
  type User,
} from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { ELO_INITIAL_RATING } from '../constants.js';
import { revokeAllRefreshTokens } from './auth.service.js';
import { writeAuditLog } from './audit.service.js';
import type {
  AdminReportsQueryInput,
  CreateReportInput,
  ResolveReportInput,
} from '../schemas/report.schema.js';
import { USER_STATUS_TO_API, type ApiUserStatus } from '../types/api.js';

/**
 * ระบบรายงานผู้เล่น (docs/api-contract.md ข้อ 8)
 *
 * ผู้ใช้แจ้ง → แอดมินตัดสิน → บทลงโทษมีผลทันทีในทรานแซกชันเดียวกับที่ปิดรายงาน
 * ทุกการตัดสินเขียน `AdminAuditLog` เสมอ (ADR-017)
 */

/** ช่วงกันรายงานซ้ำ — คนเดิมแจ้งคนเดิมได้ 1 ครั้งต่อ 24 ชั่วโมง (api-contract.md ข้อ 8) */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const reporterSelect = { select: { userId: true, username: true, nickname: true } } as const;

export interface ReportUserDto {
  userId: number;
  username: string;
  nickname: string | null;
}

export interface ReportDto {
  reportId: number;
  reportedUserId: number;
  reason: string;
  matchId: number | null;
  multiplayerMatchId: number | null;
  reportStatus: 'pending' | 'resolved';
  createdAt: string;
}

export interface AdminReportDto {
  reportId: number;
  reason: string;
  reportStatus: 'pending' | 'resolved';
  createdAt: string;
  reporter: ReportUserDto;
  reported: ReportUserDto & { status: ApiUserStatus; reportCount: number };
  matchId: number | null;
  multiplayerMatchId: number | null;
  reviewedBy: number | null;
  reviewedAt: string | null;
  actionTaken: string | null;
  adminNote: string | null;
}

const STATUS_TO_API = { PENDING: 'pending', RESOLVED: 'resolved' } as const;

/** ค่าที่ API รับ → enum `ReportAction` ใน DB (ชื่อไม่ตรงกันเป๊ะมาแต่ต้น — database-schema.md) */
const ACTION_TO_DB: Record<ResolveReportInput['action'], ReportAction> = {
  none: ReportAction.NONE,
  warning: ReportAction.WARNING,
  suspend: ReportAction.SUSPENDED,
  reset_rating: ReportAction.RATING_RESET,
};

const ACTION_TO_API: Record<ReportAction, string> = {
  NONE: 'none',
  WARNING: 'warning',
  SUSPENDED: 'suspend',
  RATING_RESET: 'reset_rating',
};

function toReportDto(report: Report): ReportDto {
  return {
    reportId: report.reportId,
    reportedUserId: report.reportedId,
    reason: report.reason,
    matchId: report.matchId,
    multiplayerMatchId: report.multiplayerMatchId,
    reportStatus: STATUS_TO_API[report.reportStatus],
    createdAt: report.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------- ฝั่งผู้ใช้ (🔒)

/**
 * แจ้งรายงานผู้เล่น
 *
 * ตรวจให้ครบก่อนเขียน เพราะ **รายงานที่ตรวจสอบไม่ได้ไม่มีประโยชน์กับใครเลย**:
 * ผู้ถูกรายงานต้องมีตัวตน · แมตช์ที่แนบต้องมีอยู่จริงและผู้ถูกรายงานต้องอยู่ในแมตช์นั้น (ADR-050 ข้อ 1)
 */
export async function createReport(
  reporterId: number,
  input: CreateReportInput,
): Promise<ReportDto> {
  if (input.reportedUserId === reporterId) {
    throw errors.validation('รายงานตัวเองไม่ได้', { reportedUserId: 'รายงานตัวเองไม่ได้' });
  }

  const reported = await prisma.user.findFirst({
    where: { userId: input.reportedUserId, deletedAt: null },
    select: { userId: true },
  });
  if (!reported) throw errors.notFound('ไม่พบผู้ใช้ที่ต้องการรายงาน');

  await assertMatchInvolvesUser(input, input.reportedUserId);

  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
  const duplicate = await prisma.report.findFirst({
    where: { reporterId, reportedId: input.reportedUserId, createdAt: { gte: since } },
    select: { reportId: true },
  });
  if (duplicate) {
    throw errors.conflict(
      'คุณเพิ่งรายงานผู้เล่นคนนี้ไปแล้ว — รายงานซ้ำได้อีกครั้งหลังผ่านไป 24 ชั่วโมง',
    );
  }

  const report = await prisma.report.create({
    data: {
      reporterId,
      reportedId: input.reportedUserId,
      reason: input.reason,
      matchId: input.matchId ?? null,
      multiplayerMatchId: input.multiplayerMatchId ?? null,
    },
  });

  return toReportDto(report);
}

/** แมตช์ที่แนบมาต้องมีอยู่จริง และผู้ถูกรายงานต้องเป็นผู้เล่นในแมตช์นั้น */
async function assertMatchInvolvesUser(input: CreateReportInput, userId: number): Promise<void> {
  if (input.matchId) {
    const match = await prisma.match.findUnique({
      where: { matchId: input.matchId },
      select: { player1Id: true, player2Id: true },
    });
    if (!match) throw errors.notFound('ไม่พบแมตช์ที่แนบมา');
    if (match.player1Id !== userId && match.player2Id !== userId) {
      throw errors.validation('ผู้ถูกรายงานไม่ได้อยู่ในแมตช์ที่แนบมา', {
        matchId: 'แมตช์นี้ไม่มีผู้เล่นคนที่ถูกรายงาน',
      });
    }
    return;
  }

  if (input.multiplayerMatchId) {
    const seat = await prisma.multiplayerMatchParticipant.findUnique({
      where: {
        multiplayerMatchId_userId: { multiplayerMatchId: input.multiplayerMatchId, userId },
      },
      select: { userId: true },
    });
    if (!seat) {
      // แยกไม่ออกว่า "ไม่มีแมตช์" หรือ "มีแมตช์แต่ไม่มีคนนี้" — ตอบข้อความเดียวพอ ผู้ใช้แก้เหมือนกัน
      throw errors.validation('ไม่พบผู้ถูกรายงานในแมตช์ที่แนบมา', {
        multiplayerMatchId: 'แมตช์นี้ไม่มีผู้เล่นคนที่ถูกรายงาน',
      });
    }
  }
}

// ---------------------------------------------------------------- ฝั่งแอดมิน (🛡️)

/** include ชุดเดียวที่ทั้งหน้ารายการและการอ่านทีละใบใช้ — รูปของแถวจะได้ไม่มีทางเพี้ยนกัน */
const adminReportInclude = {
  reporter: reporterSelect,
  reported: {
    select: {
      userId: true,
      username: true,
      nickname: true,
      status: true,
      // แอดมินต้องเห็นว่าเป็นครั้งแรกหรือครั้งที่ 12 ก่อนตัดสิน
      _count: { select: { reportsAgainst: true } },
    },
  },
} satisfies Prisma.ReportInclude;

type AdminReportRow = Prisma.ReportGetPayload<{ include: typeof adminReportInclude }>;

function toAdminReportDto(row: AdminReportRow): AdminReportDto {
  return {
    reportId: row.reportId,
    reason: row.reason,
    reportStatus: STATUS_TO_API[row.reportStatus],
    createdAt: row.createdAt.toISOString(),
    reporter: row.reporter,
    reported: {
      userId: row.reported.userId,
      username: row.reported.username,
      nickname: row.reported.nickname,
      status: USER_STATUS_TO_API[row.reported.status],
      reportCount: row.reported._count.reportsAgainst,
    },
    matchId: row.matchId,
    multiplayerMatchId: row.multiplayerMatchId,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    actionTaken: row.actionTaken ? ACTION_TO_API[row.actionTaken] : null,
    adminNote: row.adminNote,
  };
}

export async function getAdminReport(reportId: number): Promise<AdminReportDto> {
  const row = await prisma.report.findUnique({ where: { reportId }, include: adminReportInclude });
  if (!row) throw errors.notFound('ไม่พบรายงานที่ต้องการ');
  return toAdminReportDto(row);
}

export async function listReports(q: AdminReportsQueryInput) {
  const where: Prisma.ReportWhereInput =
    q.status === 'all'
      ? {}
      : { reportStatus: q.status === 'pending' ? ReportStatus.PENDING : ReportStatus.RESOLVED };

  const [total, rows] = await prisma.$transaction([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: adminReportInclude,
    }),
  ]);

  const data = rows.map(toAdminReportDto);

  return {
    data,
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.limit)),
    },
  };
}

/**
 * ตัดสินรายงาน — ปิดเรื่อง + ลงโทษ (ถ้ามี) + เขียน log **ในทรานแซกชันเดียว**
 *
 * ถ้าแยกทรานแซกชันจะเกิดกรณี "ปิดรายงานแล้วแต่บัญชียังไม่ถูกระงับ" ซึ่งไม่มีใครรู้ว่าพลาดไป
 */
export async function resolveReport(
  adminId: number,
  reportId: number,
  input: ResolveReportInput,
): Promise<AdminReportDto> {
  const report = await prisma.report.findUnique({ where: { reportId } });
  if (!report) throw errors.notFound('ไม่พบรายงานที่ต้องการ');
  if (report.reportStatus === ReportStatus.RESOLVED) {
    throw errors.conflict('รายงานนี้ถูกตัดสินไปแล้ว');
  }

  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { reportId },
      data: {
        reportStatus: ReportStatus.RESOLVED,
        actionTaken: ACTION_TO_DB[input.action],
        adminNote: input.adminNote ?? null,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });

    if (input.action === 'suspend') {
      await tx.user.update({
        where: { userId: report.reportedId },
        data: { status: UserStatus.SUSPENDED, suspendedUntil: input.suspendedUntil ?? null },
      });
      // ไม่เพิกถอน token = คนที่เพิ่งถูกระงับยังเล่นต่อได้จนกว่า refresh token จะหมดอายุ (ADR-013)
      await revokeAllRefreshTokens(report.reportedId, tx);
      await writeAuditLog(tx, {
        adminId,
        action: 'suspend_user',
        targetUserId: report.reportedId,
        detail: { reportId, until: input.suspendedUntil?.toISOString() ?? null, via: 'report' },
      });
    }

    if (input.action === 'reset_rating') {
      const before = await tx.rating.findMany({
        where: { userId: report.reportedId },
        select: { cubeType: true, eloRating: true },
      });
      // รีเซ็ต **ครบทั้ง 4 ประเภท** — คนที่โกงจนโดนรีเซ็ตไม่ควรเหลือคะแนนที่ปั่นไว้ในประเภทอื่น
      await tx.rating.updateMany({
        where: { userId: report.reportedId },
        data: { eloRating: ELO_INITIAL_RATING },
      });
      await writeAuditLog(tx, {
        adminId,
        action: 'edit_rating',
        targetUserId: report.reportedId,
        detail: {
          reportId,
          via: 'report',
          reset: true,
          before: Object.fromEntries(before.map((r) => [r.cubeType, r.eloRating])),
          after: ELO_INITIAL_RATING,
        },
      });
    }

    await writeAuditLog(tx, {
      adminId,
      action: 'resolve_report',
      targetUserId: report.reportedId,
      detail: { reportId, action: input.action, note: input.adminNote ?? null },
    });
  });

  // คืนแถวที่เพิ่งตัดสินในรูปเดียวกับหน้ารายการ — หน้าจอจะได้เอาไปทับแถวเดิมได้เลย
  return getAdminReport(reportId);
}

/** ผู้ใช้ที่มีอยู่จริงและยังไม่ลบบัญชี — ใช้ซ้ำในหลาย service ของแอดมิน */
export async function requireLiveUser(userId: number): Promise<User> {
  const user = await prisma.user.findUnique({ where: { userId } });
  if (!user) throw errors.notFound('ไม่พบผู้ใช้รายนี้');
  return user;
}
