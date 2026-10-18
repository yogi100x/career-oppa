import { z } from 'zod';

export const adminTaskRetry = z
  .object({ reason: z.string().trim().min(8).max(500) })
  .strict();
