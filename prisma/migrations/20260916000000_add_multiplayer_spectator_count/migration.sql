-- ADR-079: ห้องหลายคนโหมด custom รับผู้ชมได้ — เก็บจำนวนผู้ชมสูงสุดเหมือน Match.spectator_count
-- แถวเก่าได้ 0 ซึ่งถูกตามจริง (ตอนนั้นห้องหลายคนไม่มีผู้ชม) ไม่ต้อง backfill
-- AlterTable
ALTER TABLE "MultiplayerMatch" ADD COLUMN     "spectator_count" INTEGER NOT NULL DEFAULT 0;
