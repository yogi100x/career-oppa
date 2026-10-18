import { z } from 'zod';

export const jobSkillKindSchema = z.enum(['existing', 'supported_by_resume', 'gap']);
export type JobSkillKind = z.infer<typeof jobSkillKindSchema>;

export const jobSkillSchema = z.object({
  id: z.string().min(1),
  skill: z.string().min(1),
  kind: jobSkillKindSchema,
  priority: z.enum(['essential', 'desirable', 'unknown']),
  factIds: z.array(z.uuid()),
  requirementQuote: z.string().optional(),
});
export type JobSkill = z.infer<typeof jobSkillSchema>;

export const jobSkillClassificationSchema = z.object({
  buckets: z.object({
    existing: z.array(jobSkillSchema),
    supportedByResume: z.array(jobSkillSchema),
    gaps: z.array(jobSkillSchema),
  }),
  incompleteDetection: z.boolean(),
  incompleteRequirements: z.array(z.string()),
});
export type JobSkillClassification = z.infer<typeof jobSkillClassificationSchema>;

export const resumeReuseActionSchema = z.enum(['reuse', 'edit', 'generate']);
export type ResumeReuseAction = z.infer<typeof resumeReuseActionSchema>;
export const resumeReuseAdviceSchema = z.object({
  similarity: z.number().min(0).max(1),
  action: resumeReuseActionSchema,
  reason: z.enum(['similarity_high', 'similarity_medium', 'similarity_low', 'seniority_mismatch']),
});
export type ResumeReuseAdvice = z.infer<typeof resumeReuseAdviceSchema>;
