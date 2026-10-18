import { z } from 'zod';

export const answerContentSchema = z
  .object({
    answer: z.string().trim().min(1).max(10_000),
    fact_ids: z.array(z.uuid()).max(100),
  })
  .strict();
export const createAnswerSchema = z
  .object({ question: z.string().trim().min(1).max(3000) })
  .strict();
export const editAnswerSchema = answerContentSchema;
export const approveAnswerSchema = z
  .object({ confirmedFactPairs: z.literal(true) })
  .strict();
