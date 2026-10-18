import { describe, expect, it } from 'vitest';
import { renderResumePdf } from '@career-workspace/pdf';
import { extractCvText } from '@career-workspace/adapters/cv-text';

const lines = [
  'Raised ₹12,500 for the Pune food bank drive',
  'Exchange term at Uniwersytet Łódzki with Małgorzata Nowak',
  'Translated the Kaumatua report for Māori community partners',
  'हिन्दी भाषा में प्रस्तुति',
];

describe('resume PDF text round trip', () => {
  it('prints a dated role as a header line before its bullets', async () => {
    const bytes = await renderResumePdf({
      name: 'Sam Lee',
      contact: 'sam@example.test',
      sections: [
        {
          title: 'Experience',
          bullets: [],
          entries: [
            {
              title: 'Marketing Intern',
              organisation: 'Acme Ltd',
              start: 'Jun 2023',
              end: 'Aug 2023',
              fact_ids: [],
              bullets: [{ text: 'Wrote weekly social posts', fact_ids: [] }],
            },
          ],
        },
      ],
    });
    const text = await extractCvText(bytes, 'application/pdf');
    const header = text.indexOf('Marketing Intern, Acme Ltd');
    expect(header).toBeGreaterThan(-1);
    expect(text.indexOf('Jun 2023 – Aug 2023')).toBeGreaterThan(header);
    expect(text.indexOf('Wrote weekly social posts')).toBeGreaterThan(header);
  }, 30_000);

  it('keeps rupee, macrons, Polish letters and Devanagari readable', async () => {
    const bytes = await renderResumePdf({
      name: 'Ananya Śrīnivās',
      contact: 'ananya@example.test',
      sections: [
        {
          title: 'Experience',
          bullets: lines.map((text) => ({ text, fact_ids: [] })),
        },
      ],
    });
    const text = (await extractCvText(bytes, 'application/pdf')).normalize(
      'NFC',
    );
    expect(text).toContain('Ananya Śrīnivās');
    expect(text).toContain('Experience');
    for (const line of lines.slice(0, 3)) expect(text).toContain(line);
    // Devanagari glyphs are real text now. A pre-base vowel sign (ि) is
    // stored in visual order, so words containing it extract reordered.
    for (const word of ['भाषा', 'में', 'हन्दी']) expect(text).toContain(word);
  }, 30_000);

  it('keeps a mixed Latin and Devanagari line in order', async () => {
    const bytes = await renderResumePdf({
      name: 'Ananya Rao',
      contact: 'ananya@example.test',
      sections: [
        {
          title: 'Languages',
          bullets: [
            { text: 'Spoken Hindi: हिन्दी fluent.', fact_ids: [] },
            { text: 'Raised ₹12,500 with Māori partners', fact_ids: [] },
          ],
        },
      ],
    });
    const text = (await extractCvText(bytes, 'application/pdf'))
      .normalize('NFC')
      .replace(/\s+/g, ' ');
    // ि is stored in visual order, so हिन्दी extracts as िहन्दी.
    expect(text).toContain('Spoken Hindi: िहन्दी fluent.');
    expect(text).toContain('Raised ₹12,500 with Māori partners');
  }, 30_000);
});
