import { expect, test } from '@playwright/test';

// This spec checks the public landing page without using a saved sign-in.
test.use({ storageState: { cookies: [], origins: [] } });

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

for (const viewport of viewports) {
  test(`landing page presents the invited student pilot on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto('/');

    await expect(page).toHaveTitle('Career-Oppa — The student pilot is open');
    await expect(page.locator('body')).not.toContainText(
      /waitlist|coming soon/i,
    );
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /pilot is open to invited students.*invited Google account/i,
    );

    const signInLinks = page.getByRole('link', { name: /sign in/i });
    expect(await signInLinks.count()).toBeGreaterThan(0);
    for (const link of await signInLinks.all()) {
      await expect(link).toHaveAttribute('href', '/sign-in');
    }

    const headerSignIn = page
      .locator('header')
      .getByRole('link', { name: /sign in/i })
      .first();
    await expect(headerSignIn).toBeVisible();

    const ageFaq = page.locator('details').filter({
      hasText: 'Is this for me if I’m just starting out?',
    });
    await ageFaq.locator('summary').click();
    await expect(ageFaq.locator('p')).toContainText('aged 18 or over');

    const inviteFaq = page.locator('details').filter({
      hasText: 'When can I give it a try?',
    });
    await inviteFaq.locator('summary').click();
    await expect(inviteFaq.locator('p')).toContainText(
      'The pilot is open to invited students.',
    );
    await expect(inviteFaq.locator('p')).toContainText(
      'Sign in with the Google account your invite was sent to.',
    );
    await expect(inviteFaq.locator('p')).toContainText(
      'If you’d like an invite, talk to the founder.',
    );
    await expect(inviteFaq.locator('p')).toContainText(
      'We’d love to hear what you’re working towards.',
    );

    const priceFaq = page
      .locator('details')
      .filter({ hasText: 'Will I need to pay?' });
    await priceFaq.locator('summary').click();
    await expect(priceFaq.locator('p')).toContainText(
      '30 free credits each month',
    );
    await expect(priceFaq.locator('p')).toContainText('$5 for 100 credits');

    await expect(page.locator('.credit-total')).toContainText('30');
    await expect(page.locator('.credit-pack')).toContainText(
      '$5 for 100 credits.',
    );
    const pilotSection = page.locator('#pilot');
    await expect(pilotSection.locator('.pilot-intro')).toContainText(
      'Invited to the pilot? Sign in with the Google account your invite was sent to.',
    );
    await expect(pilotSection.locator('.pilot-intro')).toContainText(
      'We’re glad you’re here.',
    );
    const founderInvite = pilotSection.locator('.founder-invite');
    await expect(
      founderInvite.getByRole('heading', { name: 'Would you like an invite?' }),
    ).toBeVisible();
    await expect(founderInvite.locator('p')).toContainText(
      'Talk to the founder about what you’re working towards',
    );
    await expect(founderInvite.locator('p')).toContainText(
      'where a little support would help.',
    );

    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images, (image) =>
          image.decode().catch(() => undefined),
        ),
      );
    });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

    // Keep review images with the test output so they do not become baselines.
    await page.screenshot({
      path: testInfo.outputPath(`landing-${viewport.name}-full.png`),
      fullPage: true,
    });
    await page.locator('.hero').screenshot({
      path: testInfo.outputPath(`landing-${viewport.name}-hero.png`),
    });
    await page.locator('#pilot').screenshot({
      path: testInfo.outputPath(`landing-${viewport.name}-pilot.png`),
    });

    const fitsViewport = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fitsViewport).toBe(true);

    if (viewport.name === 'mobile') {
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: 'instant' }),
      );
      const navigationToggle = page.locator(
        'summary[aria-label="Open navigation"]',
      );
      await navigationToggle.click();
      const mobileSignIn = page
        .getByRole('navigation', { name: 'Mobile navigation' })
        .getByRole('link', { name: /sign in/i });
      await expect(mobileSignIn).toBeVisible();
      await expect(mobileSignIn).toHaveAttribute('href', '/sign-in');
      await page.screenshot({
        path: testInfo.outputPath('landing-mobile-open-menu.png'),
        fullPage: true,
      });
      await mobileSignIn.click();
    } else {
      await headerSignIn.click();
    }

    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(
      page.getByRole('button', { name: /continue with google/i }),
    ).toBeVisible();
  });
}
