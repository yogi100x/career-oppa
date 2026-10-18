import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createDatabase,
  jobs,
  profileFacts,
  users,
} from '@career-workspace/db';
import { expect, test } from './fixtures';
test('low-credit response offers renewal, earning and buying before another attempt', async ({
  page,
}) => {
  const url = process.env.DATABASE_TEST_URL;
  if (!url || new URL(url).pathname !== '/career_workspace_test')
    throw new Error('Use the isolated browser test database.');
  const { database, pool } = createDatabase(url);
  let jobId: string | undefined;
  let factId: string | undefined;
  let userId: string | undefined;
  let originalEntitlement:
    | {
        firstFitReviewUsed: boolean;
        firstFitReviewRequestKey: string | null;
        firstFitReviewOpportunityId: string | null;
      }
    | undefined;
  try {
    const meResponse = await page.request.get('/api/v1/me');
    expect(meResponse.ok()).toBeTruthy();
    userId = ((await meResponse.json()).data as { id: string }).id;
    const [account] = await database
      .select({
        firstFitReviewUsed: users.firstFitReviewUsed,
        firstFitReviewRequestKey: users.firstFitReviewRequestKey,
        firstFitReviewOpportunityId: users.firstFitReviewOpportunityId,
      })
      .from(users)
      .where(eq(users.id, userId));
    expect(account).toBeTruthy();
    originalEntitlement = account;
    await database
      .update(users)
      .set({ firstFitReviewUsed: true })
      .where(eq(users.id, userId));

    const factResponse = await page.request.post('/api/v1/profile/facts', {
      data: {
        kind: 'skill',
        text: `Built a reliable project with TypeScript ${randomUUID()}.`,
      },
    });
    expect(factResponse.ok()).toBeTruthy();
    factId = ((await factResponse.json()).data as { id: string }).id;
    const approvedFact = await page.request.patch(
      `/api/v1/profile/facts/${factId}`,
      { data: { status: 'approved' } },
    );
    expect(approvedFact.ok()).toBeTruthy();

    const response = await page.request.post('/api/v1/jobs', {
      data: {
        title: `Credit recovery ${randomUUID()}`,
        company: 'Browser fixture',
        text: 'Build accessible web interfaces with TypeScript. Work with product colleagues, review changes, write useful tests, and document practical customer decisions.',
      },
    });
    expect(response.status()).toBe(200);
    const saved = (await response.json()).data;
    jobId = saved.job.id;
    // This checks the UI with a recorded API error. Credit reservation limits
    // and failed-action refunds are checked against Postgres in the core suite.
    await page.route(
      `**/api/v1/opportunities/${saved.opportunity.id}/fit-review`,
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await route.fulfill({
          status: 402,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'INSUFFICIENT_CREDITS',
              message: 'You do not have enough credits for this action.',
            },
          }),
        });
      },
    );
    await page.goto(`/workspace/roles/${saved.opportunity.id}`);
    await page.getByRole('button', { name: 'Review fit · 1 credit' }).click();
    const choices = page.getByLabel('Ways to get credits');
    await expect(choices).toContainText('Your 30 free credits renew on');
    await expect(
      choices.getByRole('link', {
        name: 'Earn credits by submitting a disclosed post',
      }),
    ).toHaveAttribute('href', '/workspace/credits#earn');
    await expect(
      choices.getByRole('link', { name: 'buy a credit pack' }),
    ).toHaveAttribute('href', '/workspace/credits#buy');
  } finally {
    if (jobId) await database.delete(jobs).where(eq(jobs.id, jobId));
    if (factId)
      await database.delete(profileFacts).where(eq(profileFacts.id, factId));
    if (userId && originalEntitlement)
      await database
        .update(users)
        .set(originalEntitlement)
        .where(eq(users.id, userId));
    await pool.end();
  }
});
