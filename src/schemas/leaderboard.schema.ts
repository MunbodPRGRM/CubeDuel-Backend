import { z } from 'zod';
import { CUBE_TYPES } from '../types/cube.js';
import { dbIdSchema } from './common.schema.js';

/** กฎมาจาก docs/api-contract.md ข้อ 5 — `limit` สูงสุด 100 ตามข้อตกลง pagination ข้อ 1 */
export const leaderboardQuerySchema = z.object({
  cubeType: z.enum(CUBE_TYPES, {
    required_error: 'ต้องระบุ cubeType',
    invalid_type_error: 'cubeType ไม่ถูกต้อง',
  }),
  scope: z.enum(['all', 'weekly']).default('all'),
  sortBy: z.enum(['elo', 'bestTime']).default('elo'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type LeaderboardQueryInput = z.infer<typeof leaderboardQuerySchema>;

export const userIdParamSchema = dbIdSchema('userId');
