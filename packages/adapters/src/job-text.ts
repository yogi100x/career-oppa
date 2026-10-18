import { load } from 'cheerio';
import { LinkFetchError } from './link-fetcher';

export const MIN_JOB_TEXT_CHARACTERS = 120;

const challengePattern = /(?:just a moment\.\.\.|checking your browser|verify you are human|are you a robot|enable javascript and cookies|cf-challenge|cloudflare ray id|access denied)/i;
const removableSelectors = [
  'script', 'style', 'noscript', 'svg', 'iframe', 'template', 'head', 'nav', 'header', 'footer',
  '[hidden]', '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.cookie-banner', '.cookie-consent', '#cookie-banner', '#cf-challenge-running', '#challenge-form',
].join(',');

/** Extracts readable job text; blocked or nearly empty pages ask the user to paste the description. */
export function extractJobText(source: string, contentType = 'text/html'): string {
  if (challengePattern.test(source)) throw new LinkFetchError('NEEDS_PASTE', 'This page could not be read. Paste the role description instead.');
  const text = /^text\/plain\b/i.test(contentType)
    ? source
    : (() => {
        const $ = load(source);
        $(removableSelectors).remove();
        // Keep one line per block so "Essential" and "Desirable" lists stay apart.
        $('br').replaceWith('\n');
        $('p, li, div, h1, h2, h3, h4, h5, h6, tr, section, article, ul, ol, dt, dd').append('\n');
        return $('body').text() || $.root().text();
      })();
  const normalized = text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (normalized.length < MIN_JOB_TEXT_CHARACTERS) {
    throw new LinkFetchError('NEEDS_PASTE', 'This page could not be read. Paste the role description instead.');
  }
  return normalized;
}
