## ทำอะไร

<!-- 1–3 บรรทัด: งานก้อนนี้เปลี่ยนอะไร -->

## เช็คก่อน merge

- [ ] `npm run lint` ผ่าน 0 error
- [ ] `npm run build` ผ่าน
- [ ] `git status` สะอาด — ไม่มี `.env` / `node_modules/` / `dist/` หลุดมา
- [ ] แก้ payload ของ endpoint หรือ event → แก้ `docs/api-contract.md` / `docs/socket-events.md` **แล้ว** และไล่แก้ฝั่ง frontend ครบ
- [ ] แตะตาราง DB → อัปเดตตัวเลขสรุปใน `Rating` และเขียน `AdminAuditLog` ในทรานแซกชันเดียวกัน (ถ้าเกี่ยว)

## repo อื่นที่ต้อง merge พร้อมกัน

<!-- branch ชื่อเดียวกัน — ใส่ลิงก์ PR หรือเขียนว่า "ไม่มี" -->

- frontend:
- docs (roadmap / ADR):

> กติกาเต็มอยู่ใน `GIT-WORKFLOW.md` ของ repo เอกสาร
