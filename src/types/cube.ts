import type { CubeType as PrismaCubeType } from '@prisma/client';

/** ประเภทรูบิคที่รองรับ — ตรงกับ enum CubeType ใน docs/database-schema.md */
export const CUBE_TYPES = ['2x2x2', '3x3x3', 'pyraminx', 'pyramorphix'] as const;
export type CubeType = (typeof CUBE_TYPES)[number];

/** ชื่อชัด ๆ ไว้ใช้ในไฟล์ที่ import enum ของ Prisma มาด้วย จะได้ไม่ชนกัน */
export type ApiCubeType = CubeType;

/** map ระหว่างค่าบนสาย/API กับชื่อ enum ใน Prisma */
export const CUBE_TYPE_TO_PRISMA = {
  '2x2x2': 'CUBE_2X2X2',
  '3x3x3': 'CUBE_3X3X3',
  pyraminx: 'PYRAMINX',
  pyramorphix: 'PYRAMORPHIX',
} as const satisfies Record<CubeType, PrismaCubeType>;

/** ทางกลับ — enum ของ Prisma → ค่าที่ส่งออกทาง API */
export const PRISMA_TO_CUBE_TYPE = {
  CUBE_2X2X2: '2x2x2',
  CUBE_3X3X3: '3x3x3',
  PYRAMINX: 'pyraminx',
  PYRAMORPHIX: 'pyramorphix',
} as const satisfies Record<PrismaCubeType, CubeType>;

export function isCubeType(v: unknown): v is CubeType {
  return typeof v === 'string' && (CUBE_TYPES as readonly string[]).includes(v);
}
