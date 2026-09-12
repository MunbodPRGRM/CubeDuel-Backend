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
npx prisma migrate dev    # สร้าง 12 ตาราง
npm run seed              # ผู้ใช้ทดสอบ 10 คน (รหัสผ่านทุกบัญชี Password123!)
npm run dev               # http://localhost:4000
```

ตรวจว่าขึ้นจริง:

```bash
curl http://localhost:4000/api/v1/health
# {"status":"ok","db":"ok","uptime":12}
```

> base path คือ **`/api/v1`** ตาม `docs/api-contract.md` ข้อ 1 (ของเดิม `/api` เลิกใช้แล้ว — ADR-023)

## คำสั่งที่มี

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` | รัน dev server พร้อม watch (`tsx watch`) |
| `npm run build` | คอมไพล์ TypeScript ลง `dist/` |
| `npm start` | รันไฟล์ที่ build แล้ว |
| `npm test` | unit test ของตรรกะการตัดสิน (`node:test` + `tsx` — ไม่ต้องมี DB/server) |
| `npm run typecheck` | `tsc --noEmit` ตรวจทั้ง `src/` รวมไฟล์เทส |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run prisma:migrate` | `prisma migrate dev` |
| `npm run prisma:studio` | เปิด Prisma Studio ดูข้อมูลใน DB |
| `npm run seed` | ใส่ข้อมูลทดสอบ (`prisma/seed.ts`) |
| `npm run smoke:socket` | ทดสอบวงจรชีวิตห้องผ่าน Socket.IO จริง (ต้องมี `npm run dev` รันอยู่ + seed แล้ว) |
| `npm run smoke:match` | เล่นแมตช์จนจบจริงแล้วตรวจแถวใน DB (~2 นาที เพราะรอ inspection/grace ของจริง) |
| `npm run smoke:rated` | เล่นในห้องแข่งขันแล้วตรวจว่า Elo ขยับถูกทั้งสองฝั่ง (~1 นาที · ต้องตั้ง `ALLOW_TEST_COMPETITIVE_ROOM=1`) |
| `npm run smoke:camera` | มุมกล้องของคู่แข่ง `solve:camera` → `opponent:camera` — ส่งต่อเฉพาะช่วงที่กำหนด · ผู้ชมได้ด้วย · ผิด/ถี่เกินทิ้งเงียบ (~25 วินาที · ADR-062) |
| `npm run smoke:dev-finish` | ปุ่ม "เสร็จทันที" ของห้องแข่ง — สวิตช์ปิดตรวจว่าถูกปฏิเสธ · เปิด (`DEV_INSTANT_FINISH=true`) เล่นจนจบด้วยปุ่มนี้ (~25 วินาที · ADR-060) |

## ตัวแปรสภาพแวดล้อม

ดูรายการเต็มที่ `.env.example` — ตัวที่ **ขาดไม่ได้ตอนนี้** คือ `DATABASE_URL` (ไม่มีแล้ว server ไม่ยอมขึ้น)

| ตัวแปร | ค่าเริ่มต้น | ใช้ตอนไหน |
|---|---|---|
| `PORT` | `4000` | ตลอด |
| `CORS_ORIGIN` | `http://localhost:5173` | ตลอด |
| `DATABASE_URL` | — (**บังคับ**) | ตลอด |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | — (**บังคับ**) | ตลอด — ต้องไม่ซ้ำกัน และห้ามเป็นค่า `change-me` ตอน production |
| `JWT_ACCESS_EXPIRES` / `JWT_REFRESH_EXPIRES` | `15m` / `30d` | ADR-010 |
| `FRONTEND_URL` | ตามค่า `CORS_ORIGIN` | OAuth redirect + ลิงก์รีเซ็ตรหัสผ่าน |
| `DISABLE_RATE_LIMIT` | `false` | ตั้ง `true` เฉพาะตอน dev เวลายิงทดสอบรัว ๆ |
| `ALLOW_TEST_COMPETITIVE_ROOM` | `0` | ตั้ง `1` ให้ `room:create` สร้างห้อง `competitive` ได้ ใช้กับ `npm run smoke:rated` ก่อนคิวจับคู่จะเสร็จ (ADR-038) — production ปิดตายเสมอ |
| `DEV_INSTANT_FINISH` | `false` | ตั้ง `true` ให้ห้องแข่งมีปุ่ม "เสร็จทันที" (`solve:dev_finish`) ไว้ทดสอบ — ห้องที่ปรับคะแนนปรับ Elo ใน DB จริง (ADR-060) · **เปิดบน production ได้ตั้งแต่ ADR-060 ข้อ 7** (เดิมปิดตาย) · ⚠️ ถอดออกก่อนส่ง |
| `GOOGLE_*` / `FACEBOOK_*` | — | เฟส 2 (OAuth) |

## โครงสร้างโค้ด

```
src/
├── index.ts          จุดเริ่ม — สร้าง http server + ผูก Express กับ Socket.IO
├── app.ts            ประกอบ Express (cors, json, cookie, /api/v1, error handler)
├── constants.ts      ค่า K ของ Elo + ค่าเวลาของ state machine
├── config/env.ts     อ่านและตรวจตัวแปรสภาพแวดล้อมที่เดียว
├── types/cube.ts     4 ประเภทรูบิค + map ไป enum ของ Prisma
├── types/api.ts      แปลง DB (snake_case + enum ตัวใหญ่) → API (camelCase + ตัวเล็ก) ที่เดียว
├── types/express.d.ts  ต่อ type ให้ req.user
├── lib/elo.ts        สูตร Elo (+ `elo.test.ts`)
├── lib/ranking.ts    จัดอันดับ + ตัดสินผู้ชนะ/เสมอ (+ `ranking.test.ts`)
├── lib/anti-cheat.ts เกณฑ์ soft ของ anti-cheat (pure function ล้วน · + `anti-cheat.test.ts`)
├── lib/errors.ts     AppError + รหัส error ทั้ง 8 ตัวตามสัญญา API
├── lib/jwt.ts        เซ็น/ตรวจ access + refresh token
├── lib/password.ts   bcrypt
├── lib/tokens.ts     สุ่ม token + SHA-256
├── lib/prisma.ts     PrismaClient ตัวเดียวใช้ทั้งแอป
├── middleware/       auth (requireAuth/requireAdmin) · validate (Zod) · rate-limit · error handler
├── schemas/          กฎ validation ของ request แต่ละแบบ (Zod)
├── services/         ตรรกะจริง — route แค่รับส่ง ไม่มีตรรกะ
├── routes/index.ts   REST — health + /auth + /users + /leaderboard
└── sockets/          Socket.IO (เฟส 4 — ADR-034)
    ├── types.ts          สัญญา event ทั้งหมด **ไฟล์เดียว** ต้องตรงกับ frontend/src/socket/types.ts
    ├── errors.ts         SocketError + รหัส error ของ socket (คนละชุดกับ REST)
    ├── ack.ts            ตัวห่อ handler: Zod → rate limit → ack { ok, data | error }
    ├── auth.ts           ตรวจ JWT ตอน handshake
    ├── rate-limit.ts     token bucket ต่อ socket ต่อ event
    ├── room.ts           ห้องหนึ่งห้องในหน่วยความจำ + snapshot
    ├── room-registry.ts  ทะเบียนห้องทั้งหมด + สุ่ม room_code + หาห้องร้าง
    ├── room-service.ts   เข้า/ออกห้อง · โอน host · ยุบห้อง (ที่เดียวที่เรียก socket.join)
    ├── match.ts          state machine ของแมตช์ + ตัวจับเวลาทุกช่วง (ADR-035)
    ├── handlers.ts       ผูก event ทั้งหมดเข้ากับ socket
    └── index.ts          ประกอบทั้งหมด + สวีปเปอร์ห้องร้าง
prisma/
├── schema.prisma     12 ตารางครบ
└── seed.ts           ผู้ใช้ทดสอบ 10 คน + Rating 40 แถว
scripts/
├── recalculate-ratings.ts   ซ่อมตัวเลขสรุปในตาราง Rating
├── smoke-helpers.ts         เครื่องมือที่สโมคเทสใช้ร่วมกัน (login · socket · รอ event · แก้คิวบ์)
├── smoke-socket.ts          ทดสอบห้อง Socket.IO กับ server จริง
├── smoke-match.ts           เล่นแมตช์จนจบจริงแล้วตรวจ DB
└── smoke-rated.ts           ห้องแข่งขัน — ตรวจว่า Elo ขยับถูกทั้งสองฝั่ง
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

## สถานะ (2026-09-04) — เฟส 2 (ระบบสมาชิกด้วยรหัสผ่าน)

ใช้งานได้แล้ว:

| Endpoint | หมายเหตุ |
|---|---|
| `GET /api/v1/health` | เช็ค DB ด้วย |
| `POST /api/v1/auth/register` | สร้าง `Rating` 4 แถวในทรานแซกชันเดียว · rate limit 5/ชม. |
| `POST /api/v1/auth/login` | ใช้ username หรือ email · rate limit 10/15 นาที |
| `POST /api/v1/auth/refresh` | rotation + ตรวจจับการใช้ token ซ้ำ (ADR-013) |
| `POST /api/v1/auth/logout` · `/logout-all` | เพิกถอนเครื่องนี้ / ทุกเครื่อง |
| `POST /api/v1/auth/change-password` | เพิกถอนทุกเซสชันหลังเปลี่ยน |
| `DELETE /api/v1/auth/account` | soft delete ตาม ADR-008 |
| `GET /api/v1/users/me` | ข้อมูลตัวเอง |
| `GET /api/v1/users/:userId/ratings` | Elo + อันดับครบทั้ง 4 ประเภท 🔸 |
| `GET /api/v1/leaderboard?cubeType=3x3x3` | กระดานอันดับ (`scope=all` เท่านั้น) 🔸 |

🔸 = **เป็นงานเฟส 7 ที่ดึงมาทำก่อน** เพราะหน้าจอตามภาพดีไซน์ต้องใช้ข้อมูลจริง (ADR-024) — `scope=weekly` ยังตอบ `E_VALIDATION` อยู่

ยังไม่ได้ทำในเฟส 2: **OAuth Google/Facebook** · **ลืมรหัสผ่าน/รีเซ็ตรหัสผ่าน** (ต้องเลือกบริการส่งอีเมลก่อน) · UI ฝั่ง frontend

หมายเหตุ: `prisma/seed.ts` กับ `scripts/` ไม่ได้อยู่ใน `tsconfig.json` (รันด้วย `tsx` ไม่ได้ build ลง `dist/`) — ยังโดน ESLint ตรวจตามปกติ · ไฟล์ `*.test.ts` อยู่ข้างไฟล์จริงใน `src/` แต่ `npm run build` ตัดทิ้งด้วย `tsconfig.build.json`

## เอกสาร

สเปกจริงอยู่ใน `docs/` ที่ root ของโปรเจกต์ — `game-rules.md` (กติกา) · `socket-events.md` · `api-contract.md` · `database-schema.md` · `decisions.md` (ADR) · `roadmap.md` (ทำถึงไหนแล้ว)
