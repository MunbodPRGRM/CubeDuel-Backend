import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * token ดิบที่ส่งให้ผู้ใช้ (ลิงก์รีเซ็ตรหัสผ่าน) — DB เก็บแค่ SHA-256
 * ถ้า DB หลุด คนที่ได้ hash ไปใช้รีเซ็ตรหัสผ่านของใครไม่ได้
 */
export function generateOpaqueToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newJti(): string {
  return randomUUID();
}
