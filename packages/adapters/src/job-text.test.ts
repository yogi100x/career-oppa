import { describe, expect, it } from 'vitest';
import { LinkFetchError } from './link-fetcher';
import { extractJobText, MIN_JOB_TEXT_CHARACTERS } from './job-text';

describe('job page text extraction', () => {
  it('returns visible page text and removes scripts, styles, and navigation', () => {
    const description = 'We are hiring a software engineer. '.repeat(8);
    const html = `<html><body><nav>Menu text</nav><script>secret()</script><style>.hidden{}</style><main>${description}</main></body></html>`;
    const result = extractJobText(html);
    expect(result).toContain('We are hiring');
  });

  it('keeps one line per list item so requirement lists stay separate', () => {
    const html = `<body><h2>Essential</h2><ul><li>NMC registration</li><li>Night shifts</li></ul><h2>Desirable</h2><p>Patient records   experience</p>${'<p>More detail about the ward and team.</p>'.repeat(4)}</body>`;
    const result = extractJobText(html);
    expect(result).toContain('Essential\nNMC registration\nNight shifts\nDesirable');
    expect(result).toContain('Patient records experience');
    expect(result).not.toMatch(/Menu text|secret\(\)|hidden/);
  });

  it('asks the user to paste text for short and bot-check pages', () => {
    expect(() => extractJobText('<html><body>Too short</body></html>')).toThrow(LinkFetchError);
    expect(() => extractJobText('<title>Just a moment...</title><body>Checking your browser</body></html>')).toThrowError(
      expect.objectContaining({ code: 'NEEDS_PASTE' }),
    );
  });

  it('accepts sufficiently long plain text and rejects content below the threshold', () => {
    const plain = 'Role responsibilities include building reliable software. '.repeat(5);
    expect(extractJobText(plain, 'text/plain')).toBe(plain.trim());
    expect(() => extractJobText('a'.repeat(MIN_JOB_TEXT_CHARACTERS - 1), 'text/plain')).toThrow(LinkFetchError);
  });
});
