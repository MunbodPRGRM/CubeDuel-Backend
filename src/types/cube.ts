/** ประเภทรูบิคที่รองรับ — ตรงกับ enum CubeType ใน docs/database-schema.md */
export const CUBE_TYPES = ['2x2x2', '3x3x3', 'pyraminx', 'pyramorphix'] as const;
export type CubeType = (typeof CUBE_TYPES)[number];

/** map ระหว่างค่าบนสาย/API กับชื่อ enum ใน Prisma */
export const CUBE_TYPE_TO_PRISMA = {
  '2x2x2': 'CUBE_2X2X2',
  '3x3x3': 'CUBE_3X3X3',
  pyraminx: 'PYRAMINX',
  pyramorphix: 'PYRAMORPHIX',
} as const;

export function isCubeType(v: unknown): v is CubeType {
  return typeof v === 'string' && (CUBE_TYPES as readonly string[]).includes(v);
}
