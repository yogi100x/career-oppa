import { eq } from 'drizzle-orm';
import { createDatabase, jobs } from '@career-workspace/db';
import { expect, test } from './fixtures';

test('role lists and selected details recover from temporary read failures', async ({
  page,
}) => {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  )
    throw new Error('Use the isolated browser test database.');
  process.env.DATABASE_URL = databaseUrl;
  const { database, pool } = createDatabase(databaseUrl);
  const title = `Recovery role ${crypto.randomUUID()}`;
  const company = 'Recovery fixture company';
  let jobId: string | undefined;
  let opportunityId: string | undefined;

  try {
    const createResponse = await page.request.post('/api/v1/jobs', {
      data: {
        title,
        company,
        text: 'This is a seeded role description with enough visible text to be saved through the real jobs API. It remains available after the temporary read failure and proves the retry returned actual owner data.',
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    const created = (await createResponse.json()) as {
      data?: { job?: { id?: string }; opportunity?: { id?: string } };
    };
    jobId = created.data?.job?.id;
    opportunityId = created.data?.opportunity?.id;
    expect(jobId).toBeTruthy();
    expect(opportunityId).toBeTruthy();

    let releaseListFailure!: () => void;
    let markListStarted!: () => void;
    const listFailureGate = new Promise<void>((resolve) => {
      releaseListFailure = resolve;
    });
    const listRequestStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    let listAttempts = 0;
    let allowListRetry = false;
    await page.route('**/api/v1/opportunities', async (route) => {
      listAttempts += 1;
      if (!allowListRetry) {
        markListStarted();
        await listFailureGate;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'TEMPORARY_FAILURE',
              message: 'Temporary roles read failed.',
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/workspace?view=roles');
    await listRequestStarted;
    await expect(page.getByRole('status')).toContainText(
      'Loading your saved roles…',
    );
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(
      page.getByText(
        'No roles saved yet. Add a job link or paste its description to get started.',
      ),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^(Add your CV|Review fit)/ }),
    ).toHaveCount(0);

    releaseListFailure();
    const listError = page.getByRole('alert').filter({
      hasText: 'Temporary roles read failed.',
    });
    await expect(listError).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(
      page.getByText(
        'No roles saved yet. Add a job link or paste its description to get started.',
      ),
    ).toHaveCount(0);
    allowListRetry = true;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(listError).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: `Open ${title} at ${company}` }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'No roles saved yet. Add a job link or paste its description to get started.',
      ),
    ).toHaveCount(0);
    await expect.poll(() => listAttempts).toBeGreaterThan(1);

    let releaseDetailFailure!: () => void;
    let markDetailStarted!: () => void;
    const detailFailureGate = new Promise<void>((resolve) => {
      releaseDetailFailure = resolve;
    });
    const detailRequestStarted = new Promise<void>((resolve) => {
      markDetailStarted = resolve;
    });
    let timelineAttempts = 0;
    let allowDetailRetry = false;
    await page.route(
      `**/api/v1/opportunities/${opportunityId}/timeline`,
      async (route) => {
        timelineAttempts += 1;
        if (!allowDetailRetry) {
          markDetailStarted();
          await detailFailureGate;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'TEMPORARY_FAILURE',
                message: 'Temporary role history read failed.',
              },
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await page
      .getByRole('button', { name: `Open ${title} at ${company}` })
      .click();
    await detailRequestStarted;
    await expect(page.getByRole('status')).toContainText(
      'Loading role details…',
    );
    await expect(page.getByRole('heading', { name: title })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^(Add your CV|Review fit)/ }),
    ).toHaveCount(0);

    releaseDetailFailure();
    const detailError = page.getByRole('alert').filter({
      hasText: 'Temporary role history read failed.',
    });
    await expect(detailError).toBeVisible();
    await expect(page.getByRole('heading', { name: title })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^(Add your CV|Review fit)/ }),
    ).toHaveCount(0);
    allowDetailRetry = true;
    await detailError.getByRole('button', { name: 'Try again' }).click();
    await expect(detailError).toHaveCount(0);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^(Add your CV|Review fit)/ }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await expect.poll(() => timelineAttempts).toBeGreaterThan(1);
  } finally {
    if (jobId) await database.delete(jobs).where(eq(jobs.id, jobId));
    await pool.end();
  }
});
