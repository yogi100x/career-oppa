import { z } from 'zod';

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const yearRangePattern =
  /\b(?:19|20)\d{2}\s*(?:[-–—/.]|\bto\b)\s*(?:19|20)\d{2}\b/gi;
const phoneCandidatePattern = /\+?\d[\d\s().-]*\d/g;

/** Gives every first draft for a role the same replay-safe idempotency key. */
export function initialResumeDraftKey(opportunityId: string): string {
  return `prepare:${opportunityId}`;
}

/** Firstname-Lastname-CV.pdf in plain ASCII (safe in headers); CV.pdf if no Latin name. */
export function resumeFileName(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[Łł]/g, (letter) => (letter === 'Ł' ? 'L' : 'l'))
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.length ? `${words.join('-')}-CV.pdf` : 'CV.pdf';
}

/** Accepts an email embedded in a contact line, or an actual phone number. */
export function hasValidResumeContact(value: string): boolean {
  const contact = value.trim();
  if (!contact) return false;
  if (emailPattern.test(contact)) return true;

  const withoutYearRanges = contact
    .replace(yearRangePattern, ' ')
    .replace(emailPattern, ' ');
  return [...withoutYearRanges.matchAll(phoneCandidatePattern)].some(
    ([candidate]) => (candidate.match(/\d/g)?.length ?? 0) >= 8,
  );
}

/** Standard CV headings; a grounded role summary can lead the document. */
export const resumeSectionTitles = [
  'Summary',
  'Education',
  'Experience',
  'Projects',
  'Positions of Responsibility',
  'Skills',
  'Certifications',
  'Achievements',
] as const;

const bulletSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    fact_ids: z.array(z.uuid()).max(30),
  })
  .strict();
/** A dated role: header line (title, organisation, dates) plus its bullets. */
const entrySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    organisation: z.string().trim().max(200),
    start: z.string().trim().max(40),
    end: z.string().trim().max(40),
    fact_ids: z.array(z.uuid()).min(1).max(10),
    bullets: z.array(bulletSchema).max(10),
  })
  .strict();
export type ResumeEntry = z.infer<typeof entrySchema>;
const hasContent = (section: { bullets: unknown[]; entries?: unknown[] }) =>
  section.bullets.length + (section.entries?.length ?? 0) > 0;
const notesSchema = z.array(z.string().trim().min(1).max(500)).max(8);
const leftOutSchema = z
  .array(
    z
      .object({
        fact_id: z.uuid(),
        reason: z.string().trim().max(300),
      })
      .strict(),
  )
  .max(100);

export const resumeContentSchema = z
  .object({
    name: z.string().trim().max(200),
    contact: z.string().trim().max(500),
    sections: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            bullets: z.array(bulletSchema).max(30),
            // Older CVs have bullets only; entries are optional.
            entries: z.array(entrySchema).max(10).optional(),
          })
          .strict()
          .refine(hasContent, 'Add at least one line to each section.'),
      )
      .min(1)
      .max(12),
    // Drafting notes and dropped facts live outside sections: they never
    // print on the CV and never block approval.
    notes_for_candidate: notesSchema.optional(),
    left_out: leftOutSchema.optional(),
  })
  .strict();
export type ResumeContent = z.infer<typeof resumeContentSchema>;

/** What the drafting model must return: fixed titles, notes kept separate. */
export const tailoredCvDraftSchema = z
  .object({
    name: z.string().trim().max(200),
    contact: z.string().trim().max(500),
    sections: z
      .array(
        z
          .object({
            title: z.enum(resumeSectionTitles),
            bullets: z.array(bulletSchema).max(30),
            entries: z.array(entrySchema).max(10),
          })
          .strict()
          .refine(hasContent, 'Add at least one line to each section.'),
      )
      .min(1)
      .max(8),
    notes_for_candidate: z.array(z.string().trim().min(1).max(500)).max(5),
    left_out: leftOutSchema,
  })
  .strict();
/** The header line printed for a dated entry, e.g. "Intern, Acme Ltd, Jun 2023 – Aug 2023". */
export function resumeEntryHeader(entry: ResumeEntry): string {
  const dates = [entry.start, entry.end].filter(Boolean).join(' – ');
  return [entry.title, entry.organisation, dates].filter(Boolean).join(', ');
}

/** Every checkable line of a CV, in print order: entry headers, their bullets, then plain bullets. */
export function resumeClaims(content: ResumeContent) {
  return content.sections.flatMap((section) => [
    ...(section.entries ?? []).flatMap((entry) => [
      {
        text: resumeEntryHeader(entry),
        fact_ids: entry.fact_ids,
        header: true,
        sectionTitle: section.title,
      },
      ...entry.bullets.map((claim) => ({ ...claim, sectionTitle: section.title })),
    ]),
    ...section.bullets.map((claim) => ({ ...claim, sectionTitle: section.title })),
  ]);
}

function dateRank(value: string) {
  if (/present|current|now|ongoing/i.test(value)) return Infinity;
  const year = Number(value.match(/\b(19|20)\d{2}\b/)?.[0] ?? NaN);
  const month = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ].findIndex((name) => value.toLowerCase().includes(name));
  return Number.isNaN(year) ? -Infinity : year * 12 + Math.max(month, 0);
}

/** Puts dated entries newest first (by end date, then start date). */
export function sortResumeEntries(content: ResumeContent): ResumeContent {
  return {
    ...content,
    sections: content.sections.map((section) =>
      section.entries
        ? {
            ...section,
            entries: [...section.entries].sort(
              (a, b) =>
                dateRank(b.end || b.start) - dateRank(a.end || a.start) ||
                dateRank(b.start) - dateRank(a.start),
            ),
          }
        : section,
    ),
  };
}

export const editResumeSchema = z
  .object({ content: resumeContentSchema })
  .strict();
export const approveResumeSchema = z
  .object({
    confirmedFactPairs: z.literal(true),
    confirmedHeader: z.literal(true),
    pageSize: z.enum(['A4', 'LETTER']).default('A4'),
  })
  .strict();
