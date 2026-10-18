import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDatabase, rewardSubmissions } from '@career-workspace/db';
import { expect, test } from './fixtures';
test('candidate submits a disclosed reward post once and sees it waiting for review', async ({
  page,
}, testInfo) => {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  )
    throw new Error('Use the isolated browser test database.');
  const { database, pool } = createDatabase(databaseUrl);
  const url = `https://example.com/career-workspace-reward/${randomUUID()}`;
  let submissionId: string | undefined;
  try {
    await page.goto('/workspace/credits#earn');
    const panel = page.locator('#earn');
    await expect(
      panel.getByRole('heading', {
        name: 'Earn credits by sharing your experience',
      }),
    ).toBeVisible();
    await expect(
      panel.getByText('Your experience can be positive, mixed, or critical.', {
        exact: false,
      }),
    ).toBeVisible();
    await panel.getByLabel('Public post URL').fill(url);
    const submit = panel.getByRole('button', {
      name: 'Submit for review — free',
    });
    await expect(submit).toBeDisabled();
    const refused = await page.request.post('/api/v1/rewards', {
      data: { url, disclosureConfirmed: false },
    });
    expect(refused.status()).toBe(400);
    await panel.getByRole('checkbox').check();
    await submit.click();
    await expect(panel.getByRole('status')).toHaveText(
      'Post submitted for review. Credits are added only after approval.',
    );
    const response = await page.request.get('/api/v1/rewards');
    const saved = (await response.json()).data.find(
      (item: { url: string }) => item.url === url,
    );
    expect(saved.status).toBe('pending');
    expect(saved.creditsGranted).toBe(0);
    submissionId = saved.id;
    await panel.getByLabel('Public post URL').fill(url);
    await panel.getByRole('checkbox').check();
    await submit.click();
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(
      (
        await database
          .select()
          .from(rewardSubmissions)
          .where(eq(rewardSubmissions.url, url))
      ).length,
    ).toBe(1);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('rewards-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('rewards-phone.png') });
  } finally {
    if (submissionId)
      await database
        .delete(rewardSubmissions)
        .where(eq(rewardSubmissions.id, submissionId));
    await pool.end();
  }
});
