import { z } from 'zod';
import { CUBE_TYPES } from '../types/cube.js';
import { MAX_SCRAMBLE_COUNT } from '../services/scramble.service.js';

/** กฎมาจาก docs/api-contract.md ข้อ 6 */
export const scrambleQuerySchema = z.object({
  cubeType: z.enum(CUBE_TYPES, {
    required_error: 'ต้องระบุ cubeType',
    invalid_type_error: 'cubeType ไม่ถูกต้อง',
  }),
  count: z.coerce.number().int().min(1).max(MAX_SCRAMBLE_COUNT).default(1),
});

export type ScrambleQueryInput = z.infer<typeof scrambleQuerySchema>;
