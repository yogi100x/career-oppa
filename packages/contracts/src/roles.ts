import { z } from 'zod';

export const opportunityStatusSchema = z.enum([
  'saved',
  'reviewed',
  'preparing',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
]);
export const createJobSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    company: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200).optional(),
    url: z.url().max(2000).optional(),
    text: z.string().trim().min(120).max(100_000).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.url || value.text),
    'Add a link or paste the role description.',
  );
export const captureJobSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    company: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200).optional(),
    url: z.url().max(2000),
    text: z.string().trim().min(120).max(100_000),
  })
  .strict();
export const updateOpportunitySchema = z
  .object({ status: opportunityStatusSchema })
  .strict();
/** What the fit-review model returns: one row per stated job requirement. */
export const fitReviewSchema = z
  .object({
    verdict: z.string().trim().min(1).max(2000),
    requirements: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(500),
            importance: z.enum(['essential', 'desirable']),
            status: z.enum(['met', 'gap', 'unknown', 'constraint']),
            fact_ids: z.array(z.uuid()).max(30),
            job_quote: z.string().trim().max(500),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type FitReviewRequirement = z.infer<
  typeof fitReviewSchema
>['requirements'][number];
export type CreateJob = z.infer<typeof createJobSchema>;
export type OpportunityStatus = z.infer<typeof opportunityStatusSchema>;
