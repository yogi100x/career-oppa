import { z } from 'zod';

export const accountDeletionRequest = z.object({
  confirmation: z.literal('DELETE'),
});
export type AccountDeletionRequest = z.infer<typeof accountDeletionRequest>;
