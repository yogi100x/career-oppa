import { z } from 'zod';
import { generateStructured } from './index';

export const cvExtractionSchema = z
  .object({
    facts: z
      .array(
        z
          .object({
            kind: z.enum([
              'experience',
              'skill',
              'education',
              'achievement',
              'certification',
              'project',
              'volunteering',
              'responsibility',
              'language',
              'eligibility',
            ]),
            text: z.string().trim().min(1).max(2000),
            // Empty strings when the CV does not say.
            organisation: z.string().trim().max(200),
            role: z.string().trim().max(200),
            start: z.string().trim().max(40),
            end: z.string().trim().max(40),
            source_quote: z.string().trim().max(500),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const cvExtractionPrompt = new URL(
  './prompts/cv-extract.v3.md',
  import.meta.url,
);

export async function proposeCvFacts(text: string) {
  return generateStructured(
    cvExtractionPrompt,
    cvExtractionSchema,
    { cvText: text },
    { temperature: 0 },
  );
}
