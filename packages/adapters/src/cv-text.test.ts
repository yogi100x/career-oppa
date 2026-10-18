import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractCvText } from './cv-text';

describe('CV text extraction', () => {
  it('reads a DOCX document without rendering its content', async () => {
    const bytes = await readFile(
      new URL('./fixtures/sample-cv.docx', import.meta.url),
    );
    const text = await extractCvText(
      bytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(text).toContain('volunteer scheduling application');
  });
  it('reads the sample PDF as selectable text', async () => {
    const bytes = await readFile(
      new URL(
        '../../../apps/web/public/demo/output/pdf/career-oppa-sample-cv.pdf',
        import.meta.url,
      ),
    );
    const text = await extractCvText(bytes, 'application/pdf');
    expect(text.length).toBeGreaterThan(100);
    expect(text).toMatch(/experience|education/i);
  });
  it('rejects unreadable and unsupported documents', async () => {
    await expect(
      extractCvText(new Uint8Array([1, 2]), 'application/pdf'),
    ).rejects.toMatchObject({ code: 'INVALID_CV' });
    await expect(
      extractCvText(new Uint8Array([1, 2]), 'text/html'),
    ).rejects.toMatchObject({ code: 'INVALID_CV' });
  });
  it('rejects empty or oversized documents', async () => {
    await expect(
      extractCvText(new Uint8Array(), 'application/pdf'),
    ).rejects.toMatchObject({ code: 'INVALID_CV' });
    await expect(
      extractCvText(new Uint8Array(4 * 1024 * 1024 + 1), 'application/pdf'),
    ).rejects.toMatchObject({ code: 'INVALID_CV' });
  });
});
