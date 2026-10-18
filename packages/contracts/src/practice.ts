import { z } from 'zod';

export const createPracticeSchema = z
  .object({ opportunityId: z.uuid() })
  .strict();
export const practiceQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(1500),
    focus: z.string().trim().min(1).max(500),
  })
  .strict();
export const practiceQuestionsSchema = z
  .object({ questions: z.array(practiceQuestionSchema).min(3).max(5) })
  .strict();
export const practiceFeedbackSchema = z
  .object({
    overall: z.string().trim().min(1).max(3000),
    strengths: z.array(z.string().trim().min(1).max(1500)).max(10),
    improvements: z.array(z.string().trim().min(1).max(1500)).min(1).max(10),
    nextSteps: z.array(z.string().trim().min(1).max(1500)).min(1).max(10),
  })
  .strict();
export const practiceAnswersSchema = z
  .object({
    answers: z.array(z.string().trim().min(1).max(8000)).min(3).max(5),
    confirmed: z.literal(true),
  })
  .strict();
export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>;
export type PracticeFeedback = z.infer<typeof practiceFeedbackSchema>;
