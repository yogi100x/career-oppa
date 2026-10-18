import { z } from 'zod';

export const submitRewardSchema = z.object({
  url: z.string().url().max(2048),
  disclosureConfirmed: z.literal(true),
}).strict();

export const reviewRewardSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('reject'), reason: z.string().trim().min(1).max(1000) }).strict(),
]);

export const ledgerAdjustmentSchema = z.object({
  userId: z.string().uuid(),
  bucket: z.enum(['free', 'earned', 'purchased']),
  amount: z.number().int().safe().refine((value) => value !== 0).refine((value) => Math.abs(value) <= 100_000),
  reason: z.string().trim().min(1).max(1000),
}).strict();

export type SubmitReward = z.infer<typeof submitRewardSchema>;
export type ReviewReward = z.infer<typeof reviewRewardSchema>;
export type LedgerAdjustment = z.infer<typeof ledgerAdjustmentSchema>;
