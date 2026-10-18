import { z } from 'zod';

export const creditPackIdSchema = z.enum([
  'starter',
  'job_hunt',
  'full_season',
]);

export const checkoutSchema = z
  .object({ packId: creditPackIdSchema })
  .strict();

export const creditPackSchema = z
  .object({
    id: creditPackIdSchema,
    name: z.string().min(1),
    priceUsdCents: z.number().int().positive(),
    credits: z.number().int().positive(),
  })
  .strict();

export type CreditPackId = z.infer<typeof creditPackIdSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type CreditPack = z.infer<typeof creditPackSchema>;
