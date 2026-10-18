import { z } from 'zod';

export const createOutreachSchema = z.object({ contactId: z.uuid() }).strict();
export const outreachContentSchema = z
  .object({
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(10_000),
    fact_ids: z.array(z.uuid()).max(100),
  })
  .strict();
export const outreachHandoffSchema = z
  .object({
    confirmed: z.literal(true),
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(10_000),
    method: z.enum(['copy', 'mailto']),
  })
  .strict();
export const outreachSentSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();
export const outreachReplySchema = z
  .object({ outcome: z.enum(['reply', 'opt_out']), confirmed: z.literal(true) })
  .strict();
export type OutreachContent = z.infer<typeof outreachContentSchema>;
