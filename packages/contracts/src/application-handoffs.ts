import { z } from 'zod';

export const createApplicationHandoffSchema = z
  .object({
    opportunityId: z.uuid(),
    source: z.enum(['approved_pdf', 'employer_link']),
    resumeId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (value) => value.source !== 'approved_pdf' || Boolean(value.resumeId),
    {
      path: ['resumeId'],
      message: 'Choose the approved CV that was handed off.',
    },
  );

export const answerApplicationHandoffSchema = z
  .object({ answer: z.enum(['applied', 'not_yet']) })
  .strict();

export type CreateApplicationHandoff = z.infer<
  typeof createApplicationHandoffSchema
>;
export type AnswerApplicationHandoff = z.infer<
  typeof answerApplicationHandoffSchema
>;
