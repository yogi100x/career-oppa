import { z } from 'zod';

export const me = z.object({
  id: z.uuid(),
  role: z.enum(['candidate', 'admin']),
  coachId: z.string(),
  email: z.email().nullable().optional(),
});
export type Me = z.infer<typeof me>;
