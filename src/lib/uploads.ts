/**
 * อัปโหลดรูปประกอบข่าว — กฎทั้งหมดมาจาก docs/api-contract.md ข้อ 7
 *
 * เก็บไฟล์ไว้บน **ดิสก์ของ server** แล้วเก็บแค่ path ลง DB (`News.image`)
 * ไม่เก็บไบต์ลง DB และยังไม่ใช้ object storage — เหตุผลอยู่ใน ADR-049 ข้อ 2
 *
 * รับไฟล์เข้า memory ก่อน (ไม่เกิน 2 MB อยู่แล้ว) เพื่อ **ตรวจ magic bytes ก่อนเขียนลงดิสก์**
 * ถ้าใช้ diskStorage ไฟล์ปลอมจะถูกเขียนลงเครื่องไปแล้วค่อยรู้ว่าไม่ใช่รูป
 */
import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { errors } from './errors.js';
import { env } from '../config/env.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** พาธที่เก็บลง DB ขึ้นต้นด้วยตัวนี้เสมอ — ใช้ตอนแปลงกลับเป็นพาธจริงบนดิสก์ด้วย */
export const NEWS_IMAGE_URL_PREFIX = '/uploads/news/';

/** ชนิดไฟล์ที่ยอมรับ + นามสกุลที่ใช้จริง (ไม่เชื่อชื่อไฟล์ที่ client ส่งมา) */
const IMAGE_TYPES = [
  { ext: '.jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: '.png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP = "RIFF" .... "WEBP" — ไบต์ 4-7 เป็นขนาดไฟล์ จึงต้องตรวจสองช่วง
  { ext: '.webp', mime: 'image/webp', magic: null },
] as const;

/**
 * multer ที่รับได้ไฟล์เดียวชื่อ `image`
 *
 * ตรวจ mime ตั้งแต่ชั้นนี้เพื่อ **ตัดไฟล์ที่ไม่ใช่รูปทิ้งก่อนอ่านครบ** ส่วนการตรวจของจริง
 * (magic bytes) อยู่ที่ `saveNewsImage()` เพราะ mime ที่ client ส่งมาปลอมได้
 */
export const newsImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = IMAGE_TYPES.some((t) => t.mime === file.mimetype);
    if (ok) return cb(null, true);
    cb(errors.validation('รับเฉพาะไฟล์รูป JPEG / PNG / WebP', { image: 'ชนิดไฟล์ไม่รองรับ' }));
  },
}).single('image');

/** ชนิดไฟล์จริงจากหัวไฟล์ — `null` = ไม่ใช่รูปสามชนิดที่รองรับ */
function sniffImageType(buffer: Buffer): (typeof IMAGE_TYPES)[number] | null {
  for (const type of IMAGE_TYPES) {
    if (type.magic && type.magic.every((byte, i) => buffer[i] === byte)) return type;
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return IMAGE_TYPES[2];
  }
  return null;
}

/** โฟลเดอร์จริงบนดิสก์ของรูปข่าว */
function newsImageDir(): string {
  return path.join(env.uploadsDir, 'news');
}

/**
 * เขียนไฟล์ลงดิสก์แล้วคืน **พาธที่จะเก็บลง DB**
 *
 * ชื่อไฟล์ตั้งเองทั้งหมด (เวลา + สุ่ม + นามสกุลตามชนิดจริง) — ไม่เอาชื่อจาก client มาใช้เลย
 * เพราะชื่อไฟล์ที่ผู้ใช้ตั้งได้คือช่องทาง path traversal และไฟล์ทับกันเอง
 */
export async function saveNewsImage(file: Express.Multer.File): Promise<string> {
  const type = sniffImageType(file.buffer);
  if (!type) {
    throw errors.validation('ไฟล์ที่ส่งมาไม่ใช่รูป JPEG / PNG / WebP', {
      image: 'เนื้อไฟล์ไม่ตรงกับชนิดรูปที่รองรับ',
    });
  }

  const dir = newsImageDir();
  await mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${randomBytes(6).toString('hex')}${type.ext}`;
  await writeFile(path.join(dir, filename), file.buffer);
  return `${NEWS_IMAGE_URL_PREFIX}${filename}`;
}

/**
 * ลบไฟล์รูปของข่าวแบบ best-effort — **ห้ามทำให้ request ล้มเหลว**
 *
 * ไฟล์ที่ลบไม่สำเร็จกลายเป็นขยะบนดิสก์ ซึ่งแย่น้อยกว่าการที่ผู้ใช้ลบข่าวไม่ได้
 * เพราะไฟล์ถูกลบไปแล้วจากที่อื่น (ADR-049 ข้อ 2)
 */
export async function deleteNewsImage(storedPath: string | null): Promise<void> {
  if (!storedPath?.startsWith(NEWS_IMAGE_URL_PREFIX)) return;

  const filename = path.basename(storedPath);
  try {
    await unlink(path.join(newsImageDir(), filename));
  } catch {
    // ไฟล์ไม่อยู่แล้ว หรือ permission ไม่พอ — ปล่อยผ่าน
  }
}
