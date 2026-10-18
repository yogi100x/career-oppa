import { describe, expect, it } from 'vitest';
import type { ResumeContent } from '@career-workspace/contracts';
import { renderResumePdf } from '@career-workspace/pdf';
import { extractCvText } from '@career-workspace/adapters/cv-text';
import { getResumeAtsAudit } from './resume-ats';

const content = (overrides: Partial<ResumeContent> = {}): ResumeContent => ({
  name: 'Ananya Śrīnivās',
  contact: 'ananya@example.test · Pune, India',
  sections: [
    {
      title: 'Experience',
      bullets: [
        { text: 'Raised ₹12,500 for the Pune food bank drive', fact_ids: [] },
        { text: 'हिन्दी भाषा में प्रस्तुति', fact_ids: [] },
      ],
      entries: [],
    },
  ],
  ...overrides,
});

const byId = (
  id: string,
  result: Awaited<ReturnType<typeof getResumeAtsAudit>>,
) => result.checks.find((check) => check.id === id);

describe('deterministic resume ATS audit', () => {
  it('flags Devanagari extraction ordering in the actual rendered PDF', async () => {
    const resume = content();
    const pdf = await renderResumePdf(resume);
    const result = await getResumeAtsAudit(resume, pdf, {
      generatedByRenderer: true,
      pageSize: 'A4',
    });
    expect(result.score).toBe(70);
    expect(result.grade).toBe('C');
    expect(result.extractedText).toContain('₹12,500');
    expect(result.extractedText).toContain('िहन्दी');
    expect(byId('unicode', result)?.status).toBe('fail');
    expect(byId('text', result)?.status).toBe('fail');
    expect(byId('unicode', result)?.detail).toMatch(
      /differs from the extracted text/,
    );
    expect(byId('headings', result)?.status).toBe('pass');
    expect(byId('contact', result)?.status).toBe('pass');
    expect(result.disclaimer).toMatch(/cannot predict/i);
  }, 30_000);

  it('passes exact rupee and accented Latin text, but compares complete Unicode lines', async () => {
    const resume = content({
      sections: [
        {
          title: 'Experience',
          bullets: [
            {
              text: 'Raised ₹12,500 for the Pune food bank drive',
              fact_ids: [],
            },
            { text: 'Worked with Māori community partners', fact_ids: [] },
          ],
          entries: [],
        },
      ],
    });
    const pdf = await renderResumePdf(resume);
    const result = await getResumeAtsAudit(resume, pdf, {
      generatedByRenderer: true,
    });
    expect(result.extractedText).toContain(
      'Raised ₹12,500 for the Pune food bank drive',
    );
    expect(result.extractedText).toContain(
      'Worked with Māori community partners',
    );
    expect(byId('unicode', result)?.status).toBe('pass');
    expect(result.score).toBe(100);
  }, 30_000);

  it('requires every section to use a recognized heading on its own extracted line', async () => {
    const resume = content({
      sections: [
        {
          title: 'Experience',
          bullets: [
            {
              text: 'Raised ₹12,500 for the Pune food bank drive',
              fact_ids: [],
            },
          ],
          entries: [],
        },
        {
          title: 'Career Highlights',
          bullets: [{ text: 'Helped a local group', fact_ids: [] }],
          entries: [],
        },
      ],
    });
    const pdf = await renderResumePdf(resume);
    const result = await getResumeAtsAudit(resume, pdf, {
      generatedByRenderer: true,
    });
    expect(
      result.extractedText?.split(/\r?\n/).map((line) => line.trim()),
    ).toContain('Experience');
    expect(byId('headings', result)?.status).toBe('fail');
    expect(byId('headings', result)?.detail).toMatch(/at least one section/i);
  }, 30_000);

  it('accepts Summary as a standard heading when every section heading is recognised', async () => {
    const resume = content({
      sections: [
        {
          title: 'Summary',
          bullets: [{ text: 'An experienced team organiser', fact_ids: [] }],
          entries: [],
        },
        {
          title: 'Experience',
          bullets: [
            {
              text: 'Raised ₹12,500 for the Pune food bank drive',
              fact_ids: [],
            },
          ],
          entries: [],
        },
      ],
    });
    const pdf = await renderResumePdf(resume);
    const result = await getResumeAtsAudit(resume, pdf, {
      generatedByRenderer: true,
    });
    expect(byId('headings', result)?.status).toBe('pass');
  }, 30_000);

  it('preserves the next PDF text after rendering and extracting a previous PDF', async () => {
    const first = content({
      name: 'Ananya Śrīnivās',
      sections: [
        {
          title: 'Experience',
          bullets: [
            { text: 'Raised ₹12,500 for a local project', fact_ids: [] },
          ],
          entries: [],
        },
      ],
    });
    const firstPdf = await renderResumePdf(first);
    const firstText = await extractCvText(firstPdf, 'application/pdf');
    expect(firstText).toContain('Ananya Śrīnivās');

    const second = content({
      name: 'Sam Lee',
      contact: 'sam@example.test - London',
      sections: [
        {
          title: 'Summary',
          bullets: [{ text: 'An experienced team organiser', fact_ids: [] }],
          entries: [],
        },
        {
          title: 'Experience',
          bullets: [
            { text: 'Built useful tools for a local team', fact_ids: [] },
          ],
          entries: [],
        },
      ],
    });
    const secondPdf = await renderResumePdf(second);
    const secondText = await extractCvText(secondPdf, 'application/pdf');
    expect(secondText).toContain('Sam Lee');
    expect(
      secondText.split(/\r?\n/).map((line) => line.trim().toLowerCase()),
    ).toContain('summary');
    expect(
      byId(
        'headings',
        await getResumeAtsAudit(second, secondPdf, {
          generatedByRenderer: true,
        }),
      )?.status,
    ).toBe('pass');
  }, 30_000);

  it('keeps concurrent renders isolated when they share the renderer font store', async () => {
    const first = content({ name: 'First Candidate' });
    const second = content({ name: 'Second Candidate' });
    const [firstPdf, secondPdf] = await Promise.all([
      renderResumePdf(first),
      renderResumePdf(second),
    ]);
    const firstText = await extractCvText(firstPdf, 'application/pdf');
    const secondText = await extractCvText(secondPdf, 'application/pdf');
    expect(firstText).toContain('First Candidate');
    expect(firstText).not.toContain('Second Candidate');
    expect(secondText).toContain('Second Candidate');
    expect(secondText).not.toContain('First Candidate');
  }, 30_000);

  it('passes the Unicode check when a CV contains ASCII-only text', async () => {
    const resume = content({
      name: 'Sam Lee',
      contact: 'sam@example.test - London',
      sections: [
        {
          title: 'Experience',
          bullets: [
            { text: 'Built useful tools for a local team', fact_ids: [] },
          ],
          entries: [],
        },
      ],
    });
    const pdf = await renderResumePdf(resume);
    const result = await getResumeAtsAudit(resume, pdf, {
      generatedByRenderer: true,
    });
    expect(byId('unicode', result)?.status).toBe('pass');
    expect(byId('unicode', result)?.detail).toMatch(/ASCII-only/i);
    expect(result.score).toBe(100);
  }, 30_000);

  it('fails missing email and nonstandard headings instead of inferring them', async () => {
    const resume = content({
      contact: 'Pune, India',
      sections: [
        {
          title: 'Career Highlights',
          bullets: [
            {
              text: 'Raised ₹12,500 for the Pune food bank drive',
              fact_ids: [],
            },
          ],
          entries: [],
        },
      ],
    });
    const pdf = await renderResumePdf(resume);
    const result = await getResumeAtsAudit(resume, pdf, {
      generatedByRenderer: true,
    });
    expect(byId('contact', result)?.status).toBe('fail');
    expect(byId('contact', result)?.fix).toMatch(/email/i);
    expect(byId('headings', result)?.status).toBe('fail');
    expect(result.score).toBeLessThan(100);
  }, 30_000);

  it('leaves renderer-only checks unknown without byte provenance', async () => {
    const resume = content();
    const pdf = await renderResumePdf(resume);
    const result = await getResumeAtsAudit(resume, pdf, {
      generatedByRenderer: false,
    });
    expect(byId('layout', result)?.status).toBe('unknown');
    expect(byId('images', result)?.status).toBe('unknown');
    expect(byId('font', result)?.status).toBe('unknown');
    expect(byId('hidden', result)?.status).toBe('unknown');
    expect(result.score).toBe(30);
  }, 30_000);

  it('does not produce a passing score when extraction fails', async () => {
    const result = await getResumeAtsAudit(
      content(),
      new Uint8Array([1, 2, 3]),
      { generatedByRenderer: true },
    );
    expect(result.score).toBeNull();
    expect(result.grade).toBeNull();
    expect(byId('text', result)?.status).toBe('fail');
    expect(
      result.checks.filter((check) => check.status === 'pass'),
    ).toHaveLength(0);
    expect(
      result.checks.filter((check) => check.status === 'unknown'),
    ).toHaveLength(7);
  }, 30_000);
});
