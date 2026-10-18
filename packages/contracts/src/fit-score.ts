import { z } from 'zod';

export const fitScoreBandSchema = z.enum([
  'strong_fit',
  'worth_a_try',
  'stretch',
  'not_now',
  'more_evidence_needed',
]);
export const fitScoreConfidenceSchema = z.enum(['low', 'medium', 'high']);
export const fitScoreEvidenceStatusSchema = z.enum([
  'supported',
  'partial',
  'unknown',
]);

export const fitScoreSchema = z
  .object({
    score: z.number().min(1).max(5).nullable(),
    band: fitScoreBandSchema,
    rawScore: z.number().min(1).max(5).nullable(),
    capReason: z
      .enum(['essential_gap', 'mostly_unknown_essentials', 'thin_evidence'])
      .nullable(),
    confidence: fitScoreConfidenceSchema,
    nextAction: z.string().min(1),
    requirements: z.array(
      z.object({
        text: z.string(),
        quote: z.string(),
        importance: z.enum(['essential', 'desirable']),
        status: z.enum(['met', 'gap', 'unknown']),
        gapVerification: z
          .enum(['verified', 'unverified'])
          .nullable()
          .optional(),
        fact_ids: z.array(z.uuid()),
        nominalWeight: z.number().nonnegative(),
        weight: z.number().nonnegative(),
        contribution: z.number().nonnegative(),
      }),
    ),
    factors: z.object({
      cvMatch: z.object({
        met: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
        weightedMet: z.number().nonnegative(),
        weightedTotal: z.number().nonnegative(),
      }),
      targetRoleAlignment: z.object({
        status: z.enum(['aligned', 'not_aligned', 'unknown']),
        matchedRole: z.string().nullable(),
      }),
      compensation: z.object({
        status: z.enum(['stated', 'not_stated']),
        evidence: z.string().nullable(),
      }),
      culture: z.object({
        status: z.enum(['stated', 'not_stated']),
        evidence: z.string().nullable(),
      }),
      constraints: z.array(
        z.object({
          kind: z.enum(['work_authorisation', 'location', 'other']),
          status: z.enum(['met', 'gap', 'unknown']),
          text: z.string(),
          quote: z.string(),
        }),
      ),
    }),
    checks: z.array(z.string()).max(3),
    matched: z.array(z.string()).max(3),
    gaps: z.array(z.string()).max(3),
    evidence: z.object({
      cvMatch: fitScoreEvidenceStatusSchema,
      targetRoleAlignment: fitScoreEvidenceStatusSchema,
      compensation: fitScoreEvidenceStatusSchema,
      culture: fitScoreEvidenceStatusSchema,
      redFlags: fitScoreEvidenceStatusSchema,
    }),
  })
  .strict();

export type FitScoreBand = z.infer<typeof fitScoreBandSchema>;
export type FitScoreConfidence = z.infer<typeof fitScoreConfidenceSchema>;
export type FitScoreEvidenceStatus = z.infer<
  typeof fitScoreEvidenceStatusSchema
>;
export type FitScorecard = z.infer<typeof fitScoreSchema>;
export type FitScore = FitScorecard;

export const fitScoreBandLabels: Record<FitScoreBand, string> = {
  strong_fit: 'Strong fit',
  worth_a_try: 'Worth a try',
  stretch: 'Stretch',
  not_now: 'Not now',
  more_evidence_needed: 'More evidence needed',
};
