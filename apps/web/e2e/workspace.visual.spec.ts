import { expect, test } from './fixtures';

async function expectNoHorizontalOverflow(
  page: import('@playwright/test').Page,
  width: number,
) {
  const measured = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(measured.viewport).toBe(width);
  expect(measured.document).toBeLessThanOrEqual(width);
  expect(measured.body).toBeLessThanOrEqual(width);
}

async function openWorkspace(page: import('@playwright/test').Page) {
  await page.goto('/workspace');
  await page.waitForFunction(() => {
    const clerk = (
      window as Window & {
        Clerk?: { loaded?: boolean; user?: { id?: string } | null };
      }
    ).Clerk;
    return clerk?.loaded === true && Boolean(clerk.user?.id);
  });
  await expect(
    page.getByRole('heading', { name: 'Find a role that fits you.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open user menu' }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: 'nextjs-portal { display: none !important; }',
  });
}

test('empty workspace at desktop size', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot('workspace-desktop.png', {
    fullPage: false,
    animations: 'disabled',
    mask: [page.getByRole('button', { name: 'Open user menu' })],
    maskColor: '#a79bce',
  });
});

test('empty workspace at phone size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await expect(
    page.getByRole('navigation', { name: 'Phone navigation' }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot('workspace-phone.png', {
    fullPage: false,
    animations: 'disabled',
    mask: [page.getByRole('button', { name: 'Open user menu' })],
    maskColor: '#a79bce',
  });
  await expectNoHorizontalOverflow(page, 390);
  await page.setViewportSize({ width: 320, height: 844 });
  await expectNoHorizontalOverflow(page, 320);
});
