import { expect, type Page, type TestInfo } from '@playwright/test';

type ScreenshotOptions = Pick<
  NonNullable<Parameters<Page['screenshot']>[0]>,
  'fullPage' | 'animations' | 'mask' | 'maskColor'
>;

async function withExpandedInnerPanels(page: Page, capture: () => Promise<void>) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Visual checks require a fixed viewport.');
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const remaining = await page.evaluate(() => {
        let overflow = 0;
        for (const element of document.querySelectorAll<HTMLElement>(
          'body *',
        )) {
          if (
            ['TEXTAREA', 'INPUT', 'SELECT', 'IFRAME'].includes(element.tagName)
          )
            continue;
          const style = getComputedStyle(element);
          if (
            !/auto|scroll/.test(style.overflowY) ||
            !element.clientHeight ||
            !element.getClientRects().length
          )
            continue;
          element.scrollTop = 0;
          overflow = Math.max(
            overflow,
            element.scrollHeight - element.clientHeight,
          );
        }
        return overflow;
      });
      if (remaining <= 1) {
        await capture();
        return;
      }
      const height = page.viewportSize()!.height + remaining + 2;
      if (height > 16000)
        throw new Error('Visual content exceeded the capture height limit.');
      await page.setViewportSize({ width: viewport.width, height });
    }
    throw new Error(
      'An inner panel still clips content after expanding the screenshot viewport.',
    );
  } finally {
    await page.setViewportSize(viewport);
  }
}

/** fullPage alone does not expand the app shell's inner scrolling panels. */
export async function expectFullContentScreenshot(
  page: Page,
  name: string,
  options: ScreenshotOptions,
) {
  await withExpandedInnerPanels(page, async () => {
    await expect(page).toHaveScreenshot(name, options);
  });
}

/** Save the full rendered page after expanding any inner scrolling panels. */
export async function captureFullContentScreenshot(
  page: Page,
  path: string,
  options: ScreenshotOptions = {},
) {
  await withExpandedInnerPanels(page, async () => {
    await page.screenshot({ path, ...options, fullPage: true });
  });
}

/** Prove the normal 1440×900 page works before expanding its screenshot. */
export async function checkRoleReviewScroll(page: Page, info: TestInfo) {
  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
  const row = page.getByRole('row').filter({ hasText: 'Still unknown' });
  const footer = page
    .getByRole('button', { name: /Prepare this application/ })
    .locator('xpath=ancestor::footer');
  const before = await row.evaluate((element) => {
    let container = element.parentElement;
    while (
      container &&
      (!/auto|scroll/.test(getComputedStyle(container).overflowY) ||
        container.scrollHeight <= container.clientHeight)
    )
      container = container.parentElement;
    if (!container) throw new Error('No scrollable role panel found.');
    const rect = container.getBoundingClientRect();
    const rowRect = element.getBoundingClientRect();
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: innerHeight,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      container: {
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      },
      row: { top: rowRect.top, bottom: rowRect.bottom },
    };
  });
  await page.screenshot({
    path: info.outputPath('role-fit-1440x900-before-scroll.png'),
    mask: [page.getByRole('button', { name: 'Open user menu' })],
  });
  await page.mouse.move(
    before.container.left + before.container.width / 2,
    // The scorecard can place this row below the viewport. Wheel within the
    // visible panel so the browser routes the gesture to its scroll container.
    Math.max(100, Math.min(before.container.top + 40, page.viewportSize()!.height - 160)),
  );
  await page.mouse.wheel(
    0,
    Math.max(100, before.row.bottom - before.container.bottom + 30),
  );
  await expect
    .poll(async () =>
      row.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return [rect.top + 3, rect.bottom - 3].every((y) => {
          const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
          return Boolean(hit && element.contains(hit));
        });
      }),
    )
    .toBe(true);
  const rowBox = await row.boundingBox();
  const footerBox = await footer.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(footerBox!.y);
  await page.screenshot({
    path: info.outputPath('role-fit-1440x900-after-scroll.png'),
    mask: [page.getByRole('button', { name: 'Open user menu' })],
  });
  await info.attach('role-scroll-measurements', {
    body: JSON.stringify(
      { before, after: { row: rowBox, footer: footerBox } },
      null,
      2,
    ),
    contentType: 'application/json',
  });
}
