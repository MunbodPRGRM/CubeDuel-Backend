# CubeDuel — Backend

เซิร์ฟเวอร์ของ **CubeDuel** เกมแข่งขันรูบิค 3 มิติออนไลน์ (โปรเจกต์จบ ป.ตรี วิทยาการคอมพิวเตอร์ ม.มหาสารคาม)

รับผิดชอบ: REST API · Socket.IO ของห้องแข่งขัน · ตรรกะกติกาและการจับเวลา · คำนวณ Elo · ฐานข้อมูล

รองรับรูบิค 4 ประเภท — `2x2x2` · `3x3x3` · `pyraminx` · `pyramorphix` โดย **แยกคะแนน Elo อิสระต่อกันตามประเภท**

| ส่วน | เทคโนโลยี |
|---|---|
| Runtime | Node.js 22+ (ESM) |
| Web framework | Express 4 |
| Real-time | Socket.IO 4 |
| ภาษา | TypeScript 5 (dev รันด้วย `tsx`) |
| ฐานข้อมูล | PostgreSQL 16+ |
| ORM | Prisma 6 |
| Auth | JWT + bcrypt + OAuth (Google, Facebook) |

---

## ⚠️ สัญญาระหว่างสองฝั่งอยู่ในเอกสาร ไม่ใช่ในโค้ด

repo นี้ **โคลนมาเดี่ยว ๆ แล้วรันได้เลย** ไม่ต้องพึ่งโค้ดนอก repo (ADR-021)

แลกมาด้วยเงื่อนไข: **ไม่มี TypeScript คอยจับว่า payload ตรงกับฝั่ง frontend ไหม** — จะแก้ payload ของ endpoint หรือ socket event ไหน **ต้องเปิด `docs/api-contract.md` / `docs/socket-events.md` แก้ก่อน แล้วไล่แก้ให้ครบทั้งสองฝั่งในคราวเดียว** ถ้าลืม จะไม่มีอะไรเตือนจนกว่าจะพังตอนรันจริง

เวลาพัฒนาให้โคลนคู่กับอีกฝั่งไว้ จะได้อ่านเอกสารชุดเดียวกัน:

```
CubeDuel/
├── backend/     ← repo นี้
├── frontend/    ← github.com/MunbodPRGRM/CubeDuel-Frontend
└── docs/        ← สเปกทั้งหมด (แหล่งความจริง)
```

## สิ่งที่ต้องมี

- Node.js 22 ขึ้นไป
- PostgreSQL 16 ขึ้นไป (รันอยู่ที่เครื่อง หรือชี้ไปที่อื่นก็ได้)

## วิธีรัน dev

```bash
npm install
cp .env.example .env      # แล้วแก้ DATABASE_URL ให้ตรงเครื่องตัวเอง
npx prisma migrate dev    # (เฟส 1 ยังไม่มีตาราง — ดูหัวข้อ "สถานะ")
npm run dev               # http://localhost:4000
```

ตรวจว่าขึ้นจริง:

```bash
curl http://localhost:4000/api/health
# {"status":"ok","ts":1788439413057}
```

## คำสั่งที่มี

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` | รัน dev server พร้อม watch (`tsx watch`) |
| `npm run build` | คอมไพล์ TypeScript ลง `dist/` |
| `npm start` | รันไฟล์ที่ build แล้ว |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run prisma:migrate` | `prisma migrate dev` |
| `npm run prisma:studio` | เปิด Prisma Studio ดูข้อมูลใน DB |
| `npm run seed` | ใส่ข้อมูลทดสอบ (`prisma/seed.ts`) |

## ตัวแปรสภาพแวดล้อม

ดูรายการเต็มที่ `.env.example` — ตัวที่ **ขาดไม่ได้ตอนนี้** คือ `DATABASE_URL` (ไม่มีแล้ว server ไม่ยอมขึ้น)

| ตัวแปร | ค่าเริ่มต้น | ใช้ตอนไหน |
|---|---|---|
| `PORT` | `4000` | ตลอด |
| `CORS_ORIGIN` | `http://localhost:5173` | ตลอด |
| `DATABASE_URL` | — (**บังคับ**) | ตลอด |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | — | เฟส 2 |
| `GOOGLE_*` / `FACEBOOK_*` | — | เฟส 2 (OAuth) |

## โครงสร้างโค้ด

```
src/
├── index.ts          จุดเริ่ม — สร้าง http server + ผูก Express กับ Socket.IO
├── app.ts            ประกอบ Express (cors, json, /api)
├── constants.ts      ค่า K ของ Elo + ค่าเวลาของ state machine
├── config/env.ts     อ่านและตรวจตัวแปรสภาพแวดล้อมที่เดียว
├── types/cube.ts     4 ประเภทรูบิค + map ไป enum ของ Prisma
├── lib/elo.ts        สูตร Elo
├── lib/prisma.ts     PrismaClient ตัวเดียวใช้ทั้งแอป
├── routes/index.ts   REST — ตอนนี้มีแค่ GET /api/health
└── sockets/index.ts  Socket.IO — ตอนนี้เป็นโครงเปล่า
prisma/
├── schema.prisma     enum ครบ 12 ตัวแล้ว · ตาราง 12 ตารางยังไม่เขียน
└── seed.ts           ยังว่าง
scripts/
└── recalculate-ratings.ts   ซ่อมตัวเลขสรุปในตาราง Rating (ยังว่าง)
```

## กฎที่ห้ามละเมิด (สรุปจาก `docs/`)

- **state ของห้องแข่งขันเป็นของ server เท่านั้น** client แค่สะท้อนตาม
- **เวลาตัดสินใช้ของ server** ห้ามเชื่อเวลาที่ client ส่งมา
- ใช้ `socket.data.userId` เสมอ **ห้ามเชื่อ `userId` ที่มากับ payload**
- ส่ง **`endsAtTs` (เวลาสิ้นสุด)** ไม่ใช่ "เหลืออีกกี่วินาที"
- **scramble สร้างที่ server** ห้ามให้ client สร้างเอง
- `elo_rating` อยู่ในตาราง `Rating` (4 แถวต่อผู้ใช้ 1 คน) **ไม่ได้อยู่ใน `User`**
- `NULL` ในคอลัมน์เวลา = **DNF/DNS เสมอ** ห้ามใช้ 0 แทน
- ทุก endpoint ใต้ `/admin` ที่เปลี่ยนข้อมูล ต้องเขียน `AdminAuditLog` ในทรานแซกชันเดียวกัน

## สถานะ (2026-09-03) — เฟส 1

ใช้งานได้แล้ว: `GET /api/health` · โครง Express + Socket.IO ขึ้นได้ · ESLint/Prettier ตั้งแล้ว

ยังไม่ได้ทำ: ตารางใน `schema.prisma` (12 ตาราง) · seed · auth ทั้งหมด · event ของ Socket.IO ทุกตัว

หมายเหตุ: `prisma/seed.ts` กับ `scripts/` ไม่ได้อยู่ใน `tsconfig.json` (รันด้วย `tsx` ไม่ได้ build ลง `dist/`) — ยังโดน ESLint ตรวจตามปกติ

## เอกสาร

สเปกจริงอยู่ใน `docs/` ที่ root ของโปรเจกต์ — `game-rules.md` (กติกา) · `socket-events.md` · `api-contract.md` · `database-schema.md` · `decisions.md` (ADR) · `roadmap.md` (ทำถึงไหนแล้ว)
