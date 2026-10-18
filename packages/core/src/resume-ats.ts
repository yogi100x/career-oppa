import type { ResumeContent } from '@career-workspace/contracts';
import { extractCvText } from '@career-workspace/adapters/cv-text';
import type { ResumePageSize } from '@career-workspace/pdf';

export type ResumeAtsCheckStatus = 'pass' | 'fail' | 'unknown';
export type ResumeAtsCheck = {
  id:
    | 'text'
    | 'headings'
    | 'contact'
    | 'layout'
    | 'images'
    | 'font'
    | 'unicode'
    | 'hidden';
  label: string;
  status: ResumeAtsCheckStatus;
  weight: number;
  detail: string;
  fix?: string;
};
export type ResumeAtsAudit = {
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  checks: ResumeAtsCheck[];
  extractedText: string | null;
  disclaimer: string;
};
export type ResumeAtsAuditOptions = {
  /** True only when these exact bytes came directly from renderResumePdf. */
  generatedByRenderer: boolean;
  pageSize?: ResumePageSize;
};

const DISCLAIMER =
  'This checks readable text in your CV and common document parsing basics. It cannot predict whether an employer’s recruitment software will accept or rank your CV. Grades are capped at B when any check fails or is unknown, and at C when the text or Unicode check fails or is unknown.';
const weights = {
  text: 25,
  headings: 15,
  contact: 15,
  layout: 15,
  images: 10,
  font: 10,
  unicode: 5,
  hidden: 5,
} as const;
const normalize = (value: string) =>
  value.normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const standardHeadings = new Set([
  'summary',
  'experience',
  'work experience',
  'employment',
  'education',
  'skills',
  'projects',
  'certifications',
  'achievements',
  'positions of responsibility',
]);

export function gradeResumeAtsScore(
  score: number,
  checks: ResumeAtsCheck[],
): NonNullable<ResumeAtsAudit['grade']> {
  const scoreGrade =
    score >= 90
      ? 'A'
      : score >= 80
        ? 'B'
        : score >= 70
          ? 'C'
          : score >= 60
            ? 'D'
            : 'F';
  const rank = { A: 5, B: 4, C: 3, D: 2, F: 1 } as const;
  const textCheckNotPassing = checks.some(
    ({ id, status }) =>
      (id === 'text' || id === 'unicode') && status !== 'pass',
  );
  const anyCheckNotPassing = checks.some(({ status }) => status !== 'pass');
  const gradeCap = textCheckNotPassing ? 'C' : anyCheckNotPassing ? 'B' : 'A';
  return rank[scoreGrade] <= rank[gradeCap] ? scoreGrade : gradeCap;
}

/** Deterministic PDF text and renderer-structure audit. No AI or external calls. */
export async function getResumeAtsAudit(
  content: ResumeContent,
  pdfBytes: Uint8Array,
  options: ResumeAtsAuditOptions,
): Promise<ResumeAtsAudit> {
  let extractedText: string;
  try {
    extractedText = await extractCvText(pdfBytes, 'application/pdf');
  } catch {
    return {
      score: null,
      grade: null,
      extractedText: null,
      disclaimer: DISCLAIMER,
      checks: [
        {
          id: 'text',
          label: 'Readable text layer',
          status: 'fail',
          weight: weights.text,
          detail: 'The PDF text could not be extracted.',
          fix: 'Export a fresh, unprotected PDF with selectable text.',
        },
        ...unknownChecks(),
      ],
    };
  }

  const text = normalize(extractedText);
  const extractedLines = extractedText.split(/\r?\n/).map(normalize);
  const sectionTitles = content.sections
    .map((section) => section.title.trim())
    .filter(Boolean);
  const headingsFound =
    sectionTitles.length > 0 &&
    sectionTitles.every(
      (title) =>
        standardHeadings.has(normalize(title)) &&
        extractedLines.includes(normalize(title)),
    );
  const email = content.contact.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  )?.[0];
  const emailFound = Boolean(email && text.includes(normalize(email)));
  const visibleText = [
    content.name,
    content.contact,
    ...content.sections.flatMap((section) => [
      section.title,
      ...(section.entries ?? []).flatMap((entry) => [
        entry.title,
        entry.organisation,
        entry.start,
        entry.end,
        ...entry.bullets.map((bullet) => bullet.text),
      ]),
      ...section.bullets.map((bullet) => bullet.text),
    ]),
  ].filter(Boolean);
  const unicodeLines = visibleText.filter((line) =>
    [...line].some((character) => character.codePointAt(0)! > 127),
  );
  const expectedText = visibleText.join(' ').normalize('NFC');
  const hasUnexpectedReplacement =
    /\uFFFD/u.test(extractedText) ||
    (/[\u25A1\u25AF]/u.test(extractedText) &&
      !/[\u25A1\u25AF]/u.test(expectedText));
  // Check whole Unicode-bearing lines, not just whether their characters happen
  // to occur somewhere else. Extractors may expose ordering defects in scripts.
  const unicodeOk =
    !hasUnexpectedReplacement &&
    unicodeLines.every((line) => text.includes(normalize(line)));
  const unicodeStatus: ResumeAtsCheckStatus =
    unicodeLines.length === 0
      ? hasUnexpectedReplacement
        ? 'fail'
        : 'pass'
      : unicodeOk
        ? 'pass'
        : 'fail';
  const allSuppliedTextFound = visibleText.every((line) =>
    text.includes(normalize(line)),
  );
  const textLayerOk =
    text.length >= 40 && allSuppliedTextFound && !hasUnexpectedReplacement;
  const checks: ResumeAtsCheck[] = [
    {
      id: 'text',
      label: 'Readable text layer',
      status: textLayerOk ? 'pass' : 'fail',
      weight: weights.text,
      detail: textLayerOk
        ? 'The PDF contains selectable text, including the supplied name, contact details and CV content.'
        : text.length < 40
          ? 'The PDF has too little extractable text.'
          : 'At least one supplied name, contact detail or CV line is missing or changed in the extracted PDF text.',
      ...(textLayerOk
        ? {}
        : {
            fix: 'Export the PDF again and check that the name, contact details and CV text extract intact.',
          }),
    },
    {
      id: 'headings',
      label: 'Standard section headings',
      status: headingsFound ? 'pass' : 'fail',
      weight: weights.headings,
      detail: headingsFound
        ? 'Every section uses a common heading that appears as its own extracted text line; the PDF’s heading hierarchy was not inspected.'
        : 'At least one section uses an unrecognised heading or its heading was not extracted as a separate line.',
      ...(headingsFound
        ? {}
        : {
            fix: 'Use common headings such as Experience, Education, Skills or Projects.',
          }),
    },
    {
      id: 'contact',
      label: 'Email in document body',
      status: emailFound ? 'pass' : 'fail',
      weight: weights.contact,
      detail: emailFound
        ? 'The contact email appears in extracted body text.'
        : 'No contact email was found in the extracted PDF text.',
      ...(emailFound
        ? {}
        : { fix: 'Add an email address in the CV contact line.' }),
    },
    {
      id: 'layout',
      label: 'Single-column layout',
      status: options.generatedByRenderer ? 'pass' : 'unknown',
      weight: weights.layout,
      detail: options.generatedByRenderer
        ? `The CV was rendered with the app’s single-column ${options.pageSize ?? 'A4'} layout.`
        : 'Layout cannot be verified from extracted text alone.',
      ...(!options.generatedByRenderer
        ? {
            fix: 'Use a simple single-column layout and keep contact details in the body.',
          }
        : {}),
    },
    {
      id: 'images',
      label: 'No image-only content',
      status: options.generatedByRenderer ? 'pass' : 'unknown',
      weight: weights.images,
      detail: options.generatedByRenderer
        ? 'The app renderer adds no images.'
        : 'Images cannot be ruled out from extracted text alone.',
    },
    {
      id: 'font',
      label: 'Standard embedded text fonts',
      status: options.generatedByRenderer ? 'pass' : 'unknown',
      weight: weights.font,
      detail: options.generatedByRenderer
        ? 'The app renderer uses its bundled Noto text fonts.'
        : 'Font embedding and font mapping were not inspected.',
    },
    {
      id: 'unicode',
      label: 'Unicode text preserved',
      status: unicodeStatus,
      weight: weights.unicode,
      detail:
        unicodeLines.length === 0 && unicodeStatus === 'pass'
          ? 'The supplied CV text is ASCII-only, so no Unicode conversion was needed.'
          : unicodeOk
            ? 'Every line with accented or non-Latin text matches the extracted text after spacing and character normalisation.'
            : 'At least one supplied line with accented or non-Latin text differs from the extracted text or contains a replacement symbol.',
      ...(unicodeStatus === 'fail'
        ? {
            fix: 'Export the PDF again with a Unicode-capable font, then check that each accented or non-Latin line extracts intact.',
          }
        : {}),
    },
    {
      id: 'hidden',
      label: 'No hidden text layers',
      status: options.generatedByRenderer ? 'pass' : 'unknown',
      weight: weights.hidden,
      detail: options.generatedByRenderer
        ? 'The app renderer creates visible text without hidden duplicate text.'
        : 'Hidden or duplicated text cannot be ruled out from extracted text alone.',
    },
  ];
  const score = checks.reduce(
    (sum, check) => sum + (check.status === 'pass' ? check.weight : 0),
    0,
  );
  return {
    score,
    grade: gradeResumeAtsScore(score, checks),
    checks,
    extractedText,
    disclaimer: DISCLAIMER,
  };
}

function unknownChecks(): ResumeAtsCheck[] {
  return [
    {
      id: 'headings',
      label: 'Standard section headings',
      status: 'unknown',
      weight: weights.headings,
      detail: 'Could not inspect headings because PDF text extraction failed.',
    },
    {
      id: 'contact',
      label: 'Email in document body',
      status: 'unknown',
      weight: weights.contact,
      detail:
        'Could not inspect contact text because PDF text extraction failed.',
    },
    {
      id: 'layout',
      label: 'Single-column layout',
      status: 'unknown',
      weight: weights.layout,
      detail: 'Could not verify PDF layout.',
    },
    {
      id: 'images',
      label: 'No image-only content',
      status: 'unknown',
      weight: weights.images,
      detail: 'Could not inspect PDF content.',
    },
    {
      id: 'font',
      label: 'Standard embedded text fonts',
      status: 'unknown',
      weight: weights.font,
      detail: 'Could not inspect PDF fonts.',
    },
    {
      id: 'unicode',
      label: 'Unicode text preserved',
      status: 'unknown',
      weight: weights.unicode,
      detail: 'Could not compare PDF text with CV text.',
    },
    {
      id: 'hidden',
      label: 'No hidden text layers',
      status: 'unknown',
      weight: weights.hidden,
      detail: 'Could not inspect PDF text layers.',
    },
  ];
}
