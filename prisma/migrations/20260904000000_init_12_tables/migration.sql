-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CubeType" AS ENUM ('2x2x2', '3x3x3', 'pyraminx', 'pyramorphix');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('COMPETITIVE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "RoomMode" AS ENUM ('AUTO', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SolveResult" AS ENUM ('SOLVED', 'DNF', 'SURRENDERED');

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReportAction" AS ENUM ('NONE', 'WARNING', 'SUSPENDED', 'RATING_RESET');

-- CreateEnum
CREATE TYPE "FlagReason" AS ENUM ('IMPOSSIBLE_TIME', 'LOW_MOVE_COUNT', 'HIGH_TPS', 'MOVE_GAP', 'WIN_STREAK');

-- CreateEnum
CREATE TYPE "FlagVerdict" AS ENUM ('CLEAN', 'CHEATING', 'INCONCLUSIVE');

-- CreateTable
CREATE TABLE "User" (
    "user_id" SERIAL NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255),
    "nickname" VARCHAR(50),
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "cube_skin" VARCHAR(30) NOT NULL DEFAULT 'classic',
    "suspended_until" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "oauth_account_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "provider_user_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("oauth_account_id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "token_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("token_id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "token_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by" INTEGER,
    "device_label" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("token_id")
);

-- CreateTable
CREATE TABLE "Match" (
    "match_id" SERIAL NOT NULL,
    "room_type" "RoomType" NOT NULL,
    "cube_type" "CubeType" NOT NULL,
    "player1_id" INTEGER NOT NULL,
    "player2_id" INTEGER NOT NULL,
    "scramble" VARCHAR(255) NOT NULL,
    "room_code" VARCHAR(6),
    "player1_time" DECIMAL(6,2),
    "player2_time" DECIMAL(6,2),
    "player1_result" "SolveResult" NOT NULL,
    "player2_result" "SolveResult" NOT NULL,
    "player1_move_count" INTEGER,
    "player2_move_count" INTEGER,
    "player1_elo_before" INTEGER,
    "player1_elo_change" INTEGER,
    "player2_elo_before" INTEGER,
    "player2_elo_change" INTEGER,
    "winner_id" INTEGER,
    "spectator_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "Match_pkey" PRIMARY KEY ("match_id")
);

-- CreateTable
CREATE TABLE "Rating" (
    "user_id" INTEGER NOT NULL,
    "cube_type" "CubeType" NOT NULL,
    "elo_rating" INTEGER NOT NULL DEFAULT 1000,
    "matches_played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "best_time" DECIMAL(6,2),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("user_id","cube_type")
);

-- CreateTable
CREATE TABLE "MultiplayerMatch" (
    "multiplayer_match_id" SERIAL NOT NULL,
    "cube_type" "CubeType" NOT NULL,
    "room_mode" "RoomMode" NOT NULL,
    "scramble" VARCHAR(255) NOT NULL,
    "room_code" VARCHAR(6),
    "player_count" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "MultiplayerMatch_pkey" PRIMARY KEY ("multiplayer_match_id")
);

-- CreateTable
CREATE TABLE "MultiplayerMatchParticipant" (
    "multiplayer_match_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "solve_time" DECIMAL(6,2),
    "result" "SolveResult" NOT NULL,
    "rank_no" INTEGER NOT NULL,
    "move_count" INTEGER,
    "elo_before" INTEGER,
    "elo_change" INTEGER,

    CONSTRAINT "MultiplayerMatchParticipant_pkey" PRIMARY KEY ("multiplayer_match_id","user_id")
);

-- CreateTable
CREATE TABLE "Report" (
    "report_id" SERIAL NOT NULL,
    "reporter_id" INTEGER NOT NULL,
    "reported_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "report_status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "match_id" INTEGER,
    "multiplayer_match_id" INTEGER,
    "reviewed_by" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "action_taken" "ReportAction",
    "admin_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("report_id")
);

-- CreateTable
CREATE TABLE "News" (
    "news_id" SERIAL NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "content" TEXT NOT NULL,
    "image" VARCHAR(255),
    "author_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "News_pkey" PRIMARY KEY ("news_id")
);

-- CreateTable
CREATE TABLE "MatchFlag" (
    "flag_id" SERIAL NOT NULL,
    "match_id" INTEGER,
    "multiplayer_match_id" INTEGER,
    "user_id" INTEGER NOT NULL,
    "flag_reason" "FlagReason" NOT NULL,
    "detail" JSONB NOT NULL,
    "move_log" JSONB,
    "reviewed_by" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "verdict" "FlagVerdict",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchFlag_pkey" PRIMARY KEY ("flag_id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "log_id" SERIAL NOT NULL,
    "admin_id" INTEGER NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "target_user_id" INTEGER,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("log_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_deleted_at_idx" ON "User"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_provider_user_id_key" ON "OAuthAccount"("provider", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_user_id_provider_key" ON "OAuthAccount"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_hash_key" ON "PasswordResetToken"("token_hash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_user_id_used_at_idx" ON "PasswordResetToken"("user_id", "used_at");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_hash_key" ON "RefreshToken"("token_hash");

-- CreateIndex
CREATE INDEX "RefreshToken_user_id_revoked_at_idx" ON "RefreshToken"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "Match_cube_type_started_at_idx" ON "Match"("cube_type", "started_at");

-- CreateIndex
CREATE INDEX "Match_player1_id_started_at_idx" ON "Match"("player1_id", "started_at");

-- CreateIndex
CREATE INDEX "Match_player2_id_started_at_idx" ON "Match"("player2_id", "started_at");

-- CreateIndex
CREATE INDEX "Match_room_code_idx" ON "Match"("room_code");

-- CreateIndex
CREATE INDEX "Rating_cube_type_elo_rating_idx" ON "Rating"("cube_type", "elo_rating" DESC);

-- CreateIndex
CREATE INDEX "Rating_cube_type_best_time_idx" ON "Rating"("cube_type", "best_time" ASC);

-- CreateIndex
CREATE INDEX "MultiplayerMatch_cube_type_started_at_idx" ON "MultiplayerMatch"("cube_type", "started_at");

-- CreateIndex
CREATE INDEX "MultiplayerMatch_room_code_idx" ON "MultiplayerMatch"("room_code");

-- CreateIndex
CREATE INDEX "MultiplayerMatchParticipant_user_id_idx" ON "MultiplayerMatchParticipant"("user_id");

-- CreateIndex
CREATE INDEX "Report_report_status_created_at_idx" ON "Report"("report_status", "created_at");

-- CreateIndex
CREATE INDEX "Report_reporter_id_reported_id_created_at_idx" ON "Report"("reporter_id", "reported_id", "created_at");

-- CreateIndex
CREATE INDEX "News_created_at_idx" ON "News"("created_at" DESC);

-- CreateIndex
CREATE INDEX "MatchFlag_verdict_created_at_idx" ON "MatchFlag"("verdict", "created_at");

-- CreateIndex
CREATE INDEX "MatchFlag_user_id_created_at_idx" ON "MatchFlag"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "AdminAuditLog_admin_id_created_at_idx" ON "AdminAuditLog"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "AdminAuditLog_target_user_id_created_at_idx" ON "AdminAuditLog"("target_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_replaced_by_fkey" FOREIGN KEY ("replaced_by") REFERENCES "RefreshToken"("token_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_player1_id_fkey" FOREIGN KEY ("player1_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_player2_id_fkey" FOREIGN KEY ("player2_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_winner_id_fkey" FOREIGN KEY ("winner_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiplayerMatchParticipant" ADD CONSTRAINT "MultiplayerMatchParticipant_multiplayer_match_id_fkey" FOREIGN KEY ("multiplayer_match_id") REFERENCES "MultiplayerMatch"("multiplayer_match_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiplayerMatchParticipant" ADD CONSTRAINT "MultiplayerMatchParticipant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_multiplayer_match_id_fkey" FOREIGN KEY ("multiplayer_match_id") REFERENCES "MultiplayerMatch"("multiplayer_match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "News" ADD CONSTRAINT "News_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchFlag" ADD CONSTRAINT "MatchFlag_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchFlag" ADD CONSTRAINT "MatchFlag_multiplayer_match_id_fkey" FOREIGN KEY ("multiplayer_match_id") REFERENCES "MultiplayerMatch"("multiplayer_match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchFlag" ADD CONSTRAINT "MatchFlag_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchFlag" ADD CONSTRAINT "MatchFlag_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================
--  CHECK constraint — Prisma เขียนใน schema.prisma ไม่ได้ ต้องใส่เป็น raw SQL ที่นี่
--  ที่มา: docs/database-schema.md หัวข้อ 9 (Report) และ 11 (MatchFlag)
-- ============================================================

-- MatchFlag: ต้องชี้ไปที่แมตช์ 1v1 "หรือ" แมตช์หลายคน อย่างใดอย่างหนึ่งเท่านั้น (ห้ามว่างทั้งคู่)
ALTER TABLE "MatchFlag"
  ADD CONSTRAINT "MatchFlag_exactly_one_match_ref"
  CHECK (num_nonnulls("match_id", "multiplayer_match_id") = 1);

-- Report: ผูกกับแมตช์ได้อย่างมากหนึ่งช่อง (ว่างทั้งคู่ได้ เพราะรายงานทั่วไปไม่ผูกแมตช์)
ALTER TABLE "Report"
  ADD CONSTRAINT "Report_at_most_one_match_ref"
  CHECK (num_nonnulls("match_id", "multiplayer_match_id") <= 1);

-- Report: รายงานตัวเองไม่ได้
ALTER TABLE "Report"
  ADD CONSTRAINT "Report_no_self_report"
  CHECK ("reporter_id" <> "reported_id");

-- Match: ผู้เล่นสองฝ่ายต้องเป็นคนละคน
ALTER TABLE "Match"
  ADD CONSTRAINT "Match_players_distinct"
  CHECK ("player1_id" <> "player2_id");

-- Match: winner_id ถ้าไม่ NULL (เสมอ) ต้องเป็นผู้เล่นคนใดคนหนึ่งในแมตช์นั้น
ALTER TABLE "Match"
  ADD CONSTRAINT "Match_winner_is_a_player"
  CHECK ("winner_id" IS NULL OR "winner_id" IN ("player1_id", "player2_id"));

-- MultiplayerMatch: ห้องหลายคนมีได้ 3 หรือ 4 คนเท่านั้น
ALTER TABLE "MultiplayerMatch"
  ADD CONSTRAINT "MultiplayerMatch_player_count_range"
  CHECK ("player_count" BETWEEN 3 AND 4);
