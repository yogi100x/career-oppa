import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';

const practiceEnabled = process.env.PLAYWRIGHT_PRACTICE_ENABLED !== 'false';

for (const enabled of [true, false]) {
  test(`practice link with feature ${enabled ? 'on' : 'off'}`, async ({
    page,
  }) => {
    test.skip(
      enabled !== practiceEnabled,
      'Run with the matching server feature setting.',
    );
    const title = `Practice link role ${randomUUID().slice(0, 8)}`;
    const response = await page.request.post('/api/v1/jobs', {
      data: {
        title,
        company: 'Practice Studio',
        text: 'A complete role description for a product engineer who works with teams to build and deliver useful products. Responsibilities include collaboration, communication, planning and testing reliable software for customers.',
      },
    });
    expect(response.ok()).toBeTruthy();
    const id = (await response.json()).data.opportunity.id as string;
    const destination = `/workspace/roles/${id}/practice`;
    const link = page.getByRole('link', {
      name: 'Practice interview · 3 credits',
    });
    for (const entry of [`/workspace/roles/${id}`, '/workspace?view=roles']) {
      await page.goto(entry);
      if (entry.includes('?')) {
        await page
          .getByRole('button', { name: `Open ${title} at Practice Studio` })
          .click();
      }
      if (enabled) {
        await expect(link).toHaveAttribute('href', destination);
        await link.click();
        await expect(page).toHaveURL(new RegExp(`${destination}$`));
        await expect(
          page.getByRole('heading', { name: 'Practice your interview' }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole('heading', { name: /Practice link role/ }),
        ).toBeVisible();
        await expect(link).toHaveCount(0);
      }
    }
    if (!enabled) {
      // The route streams a loading screen first, so the status is already
      // 200 when notFound() runs; check the not-found page content instead.
      await page.goto(destination);
      await expect(page.getByText('This page could not be found')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Practice your interview' }),
      ).toHaveCount(0);
      expect(
        (
          await page.request.get(`/api/v1/practice?opportunityId=${id}`)
        ).status(),
      ).toBe(404);
    }
  });
}
