import { eq, sql } from 'drizzle-orm';
import { createDatabase, jobs } from '@career-workspace/db';
import { expect, test } from './fixtures';

test('profile, CV, documents, and workspace reads recover without showing false empties', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  )
    throw new Error('Use the isolated browser test database.');

  const { database, pool } = createDatabase(databaseUrl);
  let jobId: string | undefined;
  let opportunityId: string | undefined;
  let opportunitiesRenamed = false;

  try {
    const marker = crypto.randomUUID();
    const meResponse = await page.request.get('/api/v1/me');
    expect(meResponse.status()).toBe(200);
    const me = (await meResponse.json()) as { data?: { id: string } };
    if (!me.data?.id) throw new Error('The browser user was not loaded.');

    const roleResponse = await page.request.post('/api/v1/jobs', {
      data: {
        title: `Read recovery role ${marker}`,
        company: 'Recovery fixture company',
        text: 'This recorded role description is long enough for the role API and is used only to exercise the real workspace page, loading boundary, error boundary, and retry behavior in the isolated browser database.',
      },
    });
    expect(roleResponse.ok()).toBeTruthy();
    const role = (await roleResponse.json()) as {
      data?: { job: { id: string }; opportunity: { id: string } };
    };
    jobId = role.data?.job.id;
    opportunityId = role.data?.opportunity.id;
    expect(jobId).toBeTruthy();
    expect(opportunityId).toBeTruthy();

    let allowProfileRetry = false;
    let profileRequests = 0;
    let startProfileFailure!: () => void;
    const profileFailureStarted = new Promise<void>((resolve) => {
      startProfileFailure = resolve;
    });
    let releaseProfileFailure!: () => void;
    const profileFailureGate = new Promise<void>((resolve) => {
      releaseProfileFailure = resolve;
    });
    for (const endpoint of ['/api/v1/profile/facts', '/api/v1/projects']) {
      await page.route(`**${endpoint}`, async (route) => {
        profileRequests += 1;
        if (!allowProfileRetry) {
          startProfileFailure();
          await profileFailureGate;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'TEMPORARY_FAILURE',
                message: 'Temporary profile read failure.',
              },
            }),
          });
          return;
        }
        await route.continue();
      });
    }

    await page.goto('/workspace/profile');
    await profileFailureStarted;
    await expect(page.getByText('Loading your facts…')).toBeVisible();
    releaseProfileFailure();
    await expect(
      page.getByText('We could not load your profile. Please try again.'),
    ).toBeVisible();
    await expect(page.getByText('No facts yet.')).toHaveCount(0);
    await expect(page.getByText('No projects saved yet.')).toHaveCount(0);
    const profileRequestsBeforeRetry = profileRequests;
    allowProfileRetry = true;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByText('We could not load your profile. Please try again.'),
    ).toHaveCount(0);
    await expect
      .poll(() => profileRequests)
      .toBeGreaterThan(profileRequestsBeforeRetry);

    let allowResumeRetry = false;
    let resumeRequests = 0;
    await page.route(
      `**/api/v1/opportunities/${opportunityId}/resumes`,
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        resumeRequests += 1;
        if (!allowResumeRetry) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'TEMPORARY_FAILURE',
                message: 'Saved application data is temporarily unavailable.',
              },
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [] }),
        });
      },
    );
    // Keep the recovered page in its empty-profile state even if another test
    // has saved data for this browser identity.
    await page.route('**/api/v1/profile/facts', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { facts: [] } }),
      }),
    );
    await page.route(
      `**/api/v1/opportunities/${opportunityId}/answers`,
      async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [] }),
        }),
    );
    await page.goto(`/workspace/roles/${opportunityId}/resume`);
    await expect(
      page.getByText('Saved application data is temporarily unavailable.'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Create a tailored CV' }),
    ).toHaveCount(0);
    // The draft action stays hidden while required application data is still
    // unavailable. After recovery, the empty profile shows a disabled action.
    await expect(
      page.getByRole('button', { name: 'Review the match before drafting' }),
    ).toHaveCount(0);
    const resumeRequestsBeforeRetry = resumeRequests;
    allowResumeRetry = true;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByRole('heading', { name: /Create a tailored CV|Add a CV/ }),
    ).toBeVisible();
    await expect
      .poll(() => resumeRequests)
      .toBeGreaterThan(resumeRequestsBeforeRetry);
    await expect(
      page.getByRole('button', { name: 'Review the match before drafting' }),
    ).toBeDisabled();

    let allowDocumentsRetry = false;
    let documentRequests = 0;
    await page.route('**/api/v1/documents', async (route) => {
      documentRequests += 1;
      if (!allowDocumentsRetry) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'TEMPORARY_FAILURE',
              message: 'Your CV list is temporarily unavailable.',
            },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto('/workspace?view=documents');
    await expect(
      page.getByText('Your CV list is temporarily unavailable.'),
    ).toBeVisible();
    await expect(page.getByText('No tailored CVs yet.')).toHaveCount(0);
    const documentRequestsBeforeRetry = documentRequests;
    allowDocumentsRetry = true;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByText('Your CV list is temporarily unavailable.'),
    ).toHaveCount(0);
    await expect
      .poll(() => documentRequests)
      .toBeGreaterThan(documentRequestsBeforeRetry);

    // A table lock delays a real server component read so Next streams its
    // actual loading.tsx boundary. No application fault hook is involved.
    const lockClient = await pool.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query(
        'LOCK TABLE opportunities IN ACCESS EXCLUSIVE MODE',
      );
      const navigation = page.goto(`/workspace/roles/${opportunityId}`, {
        waitUntil: 'commit',
      });
      await expect(
        page.getByRole('heading', { name: 'Loading your workspace' }),
      ).toBeVisible();
      await lockClient.query('ROLLBACK');
      await navigation;
    } finally {
      try {
        await lockClient.query('ROLLBACK');
      } catch {
        // The transaction already rolled back after the loading proof.
      }
      lockClient.release();
    }
    await expect(
      page.getByRole('heading', { name: `Read recovery role ${marker}` }),
    ).toBeVisible();

    await database.execute(
      sql`ALTER TABLE opportunities RENAME TO opportunities_read_recovery_hidden`,
    );
    opportunitiesRenamed = true;
    try {
      await page.goto(`/workspace/roles/${opportunityId}`);
      await expect(
        page.getByRole('heading', { name: 'This page could not load' }),
      ).toBeVisible();
      await expect(page.locator('main').getByRole('alert')).toContainText(
        'We could not read your saved work.',
      );
    } finally {
      await database.execute(
        sql`ALTER TABLE opportunities_read_recovery_hidden RENAME TO opportunities`,
      );
      opportunitiesRenamed = false;
    }
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByRole('heading', { name: `Read recovery role ${marker}` }),
    ).toBeVisible();
  } finally {
    if (opportunitiesRenamed) {
      await database.execute(
        sql`ALTER TABLE opportunities_read_recovery_hidden RENAME TO opportunities`,
      );
    }
    if (jobId) await database.delete(jobs).where(eq(jobs.id, jobId));
    await pool.end();
  }
});
