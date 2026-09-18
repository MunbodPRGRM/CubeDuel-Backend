-- ADR-087: สกินเหลือ classic + 4 สกินลวดลาย (carbon · honeycomb · marble · brushed)
-- รหัสเดิม 11 ตัวถูกลบ → ผู้ใช้ที่ยังใช้อยู่กลับเป็น classic · ข้อมูลอย่างเดียว ไม่เปลี่ยนโครงตาราง
UPDATE "User"
SET "cube_skin" = 'classic'
WHERE "cube_skin" NOT IN ('classic', 'carbon', 'honeycomb', 'marble', 'brushed');
