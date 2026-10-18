/**
 * Reads the visible text of the current job page.
 * The injected function must be self-contained for chrome.scripting.
 */
export function readVisibleRolePage() {
  const skip =
    'script, style, nav, header, footer, noscript, input, textarea, select, button, [hidden], [aria-hidden="true"]';
  const heading = document.querySelector<HTMLElement>('h1');
  const title = (heading?.innerText || document.title || '').trim();
  const root =
    document.querySelector('main, [role="main"], article') || document.body;
  const lines: string[] = [];

  const visit = (element: Element) => {
    if (element.matches(skip)) return;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    )
      return;
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) visit(child as Element);
      else if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text && element.getClientRects().length > 0) lines.push(text);
      }
    }
  };
  if (root) visit(root);

  return {
    url: window.location.href,
    title: title.slice(0, 200),
    text: lines.join('\n'),
  };
}
