import { z } from 'zod';

export const contact = z.object({
  id: z.uuid(),
  name: z.string(),
  title: z.string(),
  companyName: z.string(),
  email: z.email().nullable(),
  emailStatus: z.enum(['unknown', 'VALID', 'CATCH_ALL']),
  revealedAt: z.iso.datetime().nullable(),
  source: z.literal('getleads'),
  sourceDate: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const listContacts = z.object({ contacts: z.array(contact) });

export const createSuppression = z
  .object({
    email: z.email().trim().max(320),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const suppressionRecord = z.object({
  id: z.uuid(),
  reason: z.string(),
  createdAt: z.iso.datetime(),
});

export const listSuppressions = z.object({
  suppressions: z.array(suppressionRecord),
});

export type ContactDto = z.infer<typeof contact>;
export type CreateSuppression = z.infer<typeof createSuppression>;
