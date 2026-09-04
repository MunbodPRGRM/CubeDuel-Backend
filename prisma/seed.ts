/**
 * Seed ข้อมูลทดสอบ — ผู้ใช้ 10 คน (แอดมิน 1 + สมาชิก 9) + Rating 4 แถวต่อคน
 *
 * รันด้วย: npm run seed
 * รันซ้ำได้ (idempotent) — ใช้ upsert ตาม username
 *
 * กฎที่ยึดตาม docs/database-schema.md:
 *   - ผู้ใช้ 1 คนต้องมีแถว Rating ครบทั้ง 4 cube_type ในทรานแซกชันเดียวกับที่สร้าง User
 *   - elo_rating เริ่มต้น = 1000 (ELO_INITIAL_RATING)
 */
import { PrismaClient, CubeType, UserRole } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/** ทุก cube_type — ใช้สร้าง Rating ให้ครบ 4 แถวต่อผู้ใช้ 1 คน */
const ALL_CUBE_TYPES: CubeType[] = [
  CubeType.CUBE_2X2X2,
  CubeType.CUBE_3X3X3,
  CubeType.PYRAMINX,
  CubeType.PYRAMORPHIX,
];

const ELO_INITIAL_RATING = 1000;

/** รหัสผ่านของบัญชีทดสอบทุกคน — ใช้เฉพาะตอน dev เท่านั้น */
const SEED_PASSWORD = 'Password123!';

const SEED_USERS = [
  { username: 'admin', nickname: 'ผู้ดูแลระบบ', role: UserRole.ADMIN },
  { username: 'somchai', nickname: 'Somchai' },
  { username: 'malee', nickname: 'Malee' },
  { username: 'nattapong', nickname: 'Nat' },
  { username: 'pimchanok', nickname: 'Pim' },
  { username: 'thanawat', nickname: 'Thana' },
  { username: 'kanyarat', nickname: 'Kan' },
  { username: 'supachai', nickname: 'Supachai' },
  { username: 'wanida', nickname: 'Wanida' },
  { username: 'oauthuser', nickname: 'OAuth Only', noPassword: true },
] as const;

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  for (const u of SEED_USERS) {
    // User + Rating 4 แถว ต้องอยู่ในทรานแซกชันเดียวกันเสมอ
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { username: u.username },
        update: {},
        create: {
          username: u.username,
          email: `${u.username}@cubeduel.local`,
          // ผู้ใช้ OAuth ไม่มีรหัสผ่าน — password_hash เป็น NULL ได้
          passwordHash: 'noPassword' in u && u.noPassword ? null : passwordHash,
          nickname: u.nickname,
          role: 'role' in u ? u.role : UserRole.MEMBER,
        },
      });

      await tx.rating.createMany({
        data: ALL_CUBE_TYPES.map((cubeType) => ({
          userId: user.userId,
          cubeType,
          eloRating: ELO_INITIAL_RATING,
        })),
        skipDuplicates: true,
      });
    });
  }

  const userCount = await prisma.user.count();
  const ratingCount = await prisma.rating.count();
  console.log(`[seed] ผู้ใช้ ${userCount} คน · Rating ${ratingCount} แถว (ควรเป็น ${userCount * 4})`);
  console.log(`[seed] รหัสผ่านของทุกบัญชี: ${SEED_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error('[seed] ล้มเหลว:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
