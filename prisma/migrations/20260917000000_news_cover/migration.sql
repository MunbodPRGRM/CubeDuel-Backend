-- ADR-084: เลิกอัปโหลดรูปข่าว — ปกเป็นคีย์ของชุดที่เว็บวาดให้ (general · update · maintenance · penalty · event)
-- แถวเดิมได้ general ทั้งหมด ไม่เดาปกจากรูปเดิม · ไฟล์ใน uploads/news/ ลบด้วยมือ (ไม่มีโค้ดไหนอ้างถึงแล้ว)
-- AlterTable
ALTER TABLE "News" ADD COLUMN     "cover" VARCHAR(20) NOT NULL DEFAULT 'general';

-- AlterTable
ALTER TABLE "News" DROP COLUMN "image";
