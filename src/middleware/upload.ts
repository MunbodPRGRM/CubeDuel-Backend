import type { RequestHandler } from 'express';
import multer from 'multer';
import { errors } from '../lib/errors.js';
import { MAX_IMAGE_BYTES, newsImageUpload } from '../lib/uploads.js';

/**
 * รับรูปประกอบข่าวจากช่อง `image` (ไม่บังคับ) — request ที่ไม่ใช่ `multipart/form-data` ผ่านได้ตามปกติ
 *
 * มีไว้เพื่อแปลง error ของ multer ให้เป็น envelope เดียวกับ endpoint อื่น (api-contract.md ข้อ 1)
 * ไม่งั้นไฟล์ใหญ่เกินจะเด้งเป็น 500 พร้อมข้อความอังกฤษของ library
 */
export const newsImageField: RequestHandler = (req, res, next) => {
  newsImageUpload(req, res, (err: unknown) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `ไฟล์รูปต้องมีขนาดไม่เกิน ${MAX_IMAGE_BYTES / 1024 / 1024} MB`
          : 'ส่งไฟล์รูปได้ครั้งละ 1 ไฟล์ ในช่องชื่อ image';
      return next(errors.validation(message, { image: message }));
    }
    next(err);
  });
};
