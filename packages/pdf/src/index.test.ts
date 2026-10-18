import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countPdfPages, pdfPackageName, renderResumePdf } from './index';

const sample = {
  name: 'Alex Morgan',
  contact: 'London | alex@example.test',
  sections: [
    {
      title: 'Experience',
      bullets: [
        {
          text: 'Built a clear, accessible workspace for a community team.',
          fact_ids: ['00000000-0000-4000-8000-000000000001'],
        },
      ],
    },
  ],
};

describe('resume PDF renderer', () => {
  it('exposes the package identifier', () => {
    expect(pdfPackageName).toBe('@career-workspace/pdf');
  });

  it.each(['A4', 'LETTER'] as const)(
    'creates a PDF on %s paper',
    async (pageSize) => {
      const bytes = await renderResumePdf(sample, pageSize);
      expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
      expect(bytes.byteLength).toBeGreaterThan(1000);
      expect(countPdfPages(bytes)).toBe(1);
    },
  );

  it('names every font file literally so the Next bundler keeps all four', () => {
    // Next rewrites new URL(`../fonts/${name}.ttf`) to a single file, which
    // made every CV font NotoSans-Bold in the server and garbled Devanagari.
    const source = readFileSync(
      new URL('./index.tsx', import.meta.url),
      'utf8',
    ).replace(/\/\/.*$/gm, '');
    const urls = [...source.matchAll(/new URL\(\s*([^,]+),/g)].map((match) =>
      match[1].trim(),
    );
    expect(urls).toEqual([
      "'../fonts/NotoSans-Regular.ttf'",
      "'../fonts/NotoSans-Bold.ttf'",
      "'../fonts/NotoSansDevanagari-Regular.ttf'",
      "'../fonts/NotoSansDevanagari-Bold.ttf'",
    ]);
  });

  it('embeds the regular, bold and Devanagari fonts, never Helvetica', async () => {
    const bytes = await renderResumePdf({
      ...sample,
      sections: [
        {
          title: 'Languages',
          bullets: [{ text: 'Spoken Hindi: हिन्दी fluent.', fact_ids: [] }],
        },
      ],
    });
    const fonts = new Set(
      new TextDecoder('latin1')
        .decode(bytes)
        .match(/\/BaseFont \/[A-Z]{6}\+[\w-]+|\/BaseFont \/\w+/g)
        ?.map((name) => name.replace(/^\/BaseFont \/([A-Z]{6}\+)?/, '')),
    );
    expect([...fonts].sort()).toEqual([
      'NotoSans-Bold',
      'NotoSans-Regular',
      'NotoSansDevanagari-Regular',
    ]);
  });

  it('counts more than one page for a long CV', async () => {
    const long = {
      ...sample,
      sections: [
        {
          title: 'Experience',
          bullets: Array.from({ length: 60 }, (_, index) => ({
            text: `Organised community event number ${index + 1} for students across the city.`,
            fact_ids: [],
          })),
        },
      ],
    };
    expect(countPdfPages(await renderResumePdf(long, 'A4'))).toBeGreaterThan(1);
  });
});
