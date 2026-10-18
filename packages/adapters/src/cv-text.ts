import mammoth from 'mammoth';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 100_000;
const MAX_PAGES = 30;

export class CvTextError extends Error {
  constructor(
    public code: 'INVALID_CV' | 'CV_TOO_LONG' | 'CV_NEEDS_TEXT',
    message: string,
  ) {
    super(message);
  }
}

function cleanText(value: string): string {
  const text = value
    .split(String.fromCharCode(0))
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (text.length > MAX_TEXT)
    throw new CvTextError('CV_TOO_LONG', 'Use a shorter CV.');
  if (text.length < 40)
    throw new CvTextError(
      'CV_NEEDS_TEXT',
      'This CV has too little readable text. Upload a document with selectable text.',
    );
  return text;
}

/** Reads document text only; never renders or follows links in uploaded documents. */
export async function extractCvText(
  contents: Uint8Array,
  contentType: string,
): Promise<string> {
  if (!contents.length || contents.length > MAX_BYTES)
    throw new CvTextError(
      'INVALID_CV',
      'Upload a PDF or DOCX no larger than 4 MB.',
    );
  try {
    if (
      contentType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(contents),
      });
      return cleanText(result.value);
    }
    if (contentType !== 'application/pdf')
      throw new CvTextError('INVALID_CV', 'Upload a PDF or DOCX.');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({
      data: new Uint8Array(contents),
      useSystemFonts: true,
      verbosity: 0,
    });
    try {
      const document = await loading.promise;
      if (document.numPages > MAX_PAGES)
        throw new CvTextError(
          'CV_TOO_LONG',
          'Use a CV with 30 pages or fewer.',
        );
      const pages: string[] = [];
      let length = 0;
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) =>
            'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '',
          )
          .join('');
        length += text.length;
        if (length > MAX_TEXT)
          throw new CvTextError('CV_TOO_LONG', 'Use a shorter CV.');
        pages.push(text);
        page.cleanup();
      }
      return cleanText(pages.join('\n\n'));
    } finally {
      await loading.destroy();
    }
  } catch (error) {
    if (error instanceof CvTextError) throw error;
    throw new CvTextError(
      'INVALID_CV',
      'This document could not be read. Try an unprotected PDF or DOCX.',
    );
  }
}
