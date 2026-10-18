import { expect, test } from '@playwright/test';

// This spec must exercise the public auth surface, even though the chromium
// project normally loads a signed-in user session for workspace tests.
test.use({ storageState: { cookies: [], origins: [] } });

test('offers Google sign-up and sign-in without an age confirmation step', async ({
  page,
}) => {
  for (const path of ['/sign-up', '/sign-in']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(path);

    const googleButton = page.getByRole('button', {
      name: /continue with google/i,
    });

    await expect(googleButton).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(googleButton).toBeVisible({ timeout: 20_000 });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(googleButton).toBeVisible();
    const fitsMobileWidth = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fitsMobileWidth).toBe(true);
  }
});
