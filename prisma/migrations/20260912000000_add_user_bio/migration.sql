-- ADR-066: ข้อความแนะนำตัวในโปรไฟล์
-- nullable ล้วน ไม่มี backfill · VARCHAR(300) เป็นด่านสุดท้ายเผื่อ validation ฝั่ง app พลาด
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bio" VARCHAR(300);
