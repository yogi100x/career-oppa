import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Page } from '@playwright/test';
import { getDatabase, jobs } from '@career-workspace/db';
import { expect, test } from './fixtures';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function failFirstGet(page: Page, pathname: string) {
  const gate = deferred();
  const started = deferred();
  let attempts = 0;
  let allowRetry = false;
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      attempts += 1;
      if (allowRetry) {
        await route.continue();
        return;
      }
      started.release();
      await gate.promise;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'TEMPORARY_FAILURE',
            message: 'Internal upstream detail must stay hidden.',
          },
        }),
      });
    },
  );
  return {
    started: started.promise,
    release: gate.release,
    allowRetry: () => {
      allowRetry = true;
    },
    attempts: () => attempts,
  };
}

async function createRole(page: Page, title: string) {
  const response = await page.request.post('/api/v1/jobs', {
    data: {
      title,
      company: 'Read recovery fixture',
      text: 'Build accessible product tools with TypeScript. Work with designers, review code, write useful tests, and explain decisions to the team.',
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    data?: { job?: { id: string }; opportunity?: { id: string } };
  };
  expect(body.data?.job?.id).toBeTruthy();
  expect(body.data?.opportunity?.id).toBeTruthy();
  return {
    jobId: body.data!.job!.id,
    opportunityId: body.data!.opportunity!.id,
  };
}

test('first read failures show retry without false empty states or paid actions', async ({
  page,
}) => {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  )
    throw new Error('Use DATABASE_TEST_URL with career_workspace_test.');
  process.env.DATABASE_URL = databaseUrl;
  const database = getDatabase();
  const jobIds: string[] = [];

  try {
    const coachRead = await failFirstGet(page, '/api/v1/coach/messages');
    await page.goto('/workspace/coach');
    await coachRead.started;
    await expect(
      page.getByRole('status').filter({
        hasText: 'Loading your coach workspace…',
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Ask about your profile, saved roles, or what to do next.',
      ),
    ).toHaveCount(0);
    coachRead.release();
    const coachError = page.getByRole('alert').filter({
      hasText: 'Your coach workspace could not be loaded. Try again.',
    });
    await expect(coachError).toBeVisible();
    await expect(
      page.getByText('Internal upstream detail must stay hidden.'),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        'Ask about your profile, saved roles, or what to do next.',
      ),
    ).toHaveCount(0);
    coachRead.allowRetry();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(coachError).toHaveCount(0);
    await expect.poll(coachRead.attempts).toBeGreaterThan(1);

    const postRead = await failFirstGet(page, '/api/v1/posts');
    await page.goto('/workspace/posts');
    await postRead.started;
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading your posts…' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Draft post · 1 credit' }),
    ).toHaveCount(0);
    postRead.release();
    const postError = page
      .getByRole('alert')
      .filter({ hasText: 'Your saved posts could not be loaded. Try again.' });
    await expect(postError).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Your drafts' }),
    ).toHaveCount(0);
    await expect(page.getByText(/No posts yet\./)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Draft post · 1 credit' }),
    ).toHaveCount(0);
    await expect(
      page.getByText('Internal upstream detail must stay hidden.'),
    ).toHaveCount(0);
    postRead.allowRetry();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByRole('heading', { name: 'Your drafts' }),
    ).toBeVisible();
    await expect(postError).toHaveCount(0);
    await expect.poll(postRead.attempts).toBeGreaterThan(1);

    const practiceRole = await createRole(
      page,
      `Practice retry ${randomUUID()}`,
    );
    jobIds.push(practiceRole.jobId);
    const practiceRead = await failFirstGet(page, '/api/v1/practice');
    await page.goto(`/workspace/roles/${practiceRole.opportunityId}/practice`);
    await practiceRead.started;
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Loading your saved practice…' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Start practice · 3 credits' }),
    ).toHaveCount(0);
    practiceRead.release();
    const practiceError = page.getByRole('alert').filter({
      hasText: 'Saved practice for this role could not be loaded. Try again.',
    });
    await expect(practiceError).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Start practice · 3 credits' }),
    ).toHaveCount(0);
    await expect(page.getByText(/Get role-specific questions/)).toHaveCount(0);
    practiceRead.allowRetry();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByRole('button', { name: 'Start practice · 3 credits' }),
    ).toBeVisible();
    await expect(practiceError).toHaveCount(0);
    await expect.poll(practiceRead.attempts).toBeGreaterThan(1);

    const contactRole = await createRole(
      page,
      `Contacts retry ${randomUUID()}`,
    );
    jobIds.push(contactRole.jobId);
    const contactRead = await failFirstGet(
      page,
      `/api/v1/opportunities/${contactRole.opportunityId}/contacts`,
    );
    await page.goto(`/workspace/roles/${contactRole.opportunityId}`);
    await expect(
      page.getByRole('heading', { name: 'Contacts', exact: true }),
    ).toBeVisible();
    await contactRead.started;
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading contacts…' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Search contacts · free' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Reveal email/ }),
    ).toHaveCount(0);
    contactRead.release();
    const contactError = page.getByRole('alert').filter({
      hasText: 'Contacts and outreach could not be loaded. Try again.',
    });
    await expect(contactError).toBeVisible();
    await expect(
      page.getByText(/No contacts saved for this role yet/),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Search contacts · free' }),
    ).toHaveCount(0);
    contactRead.allowRetry();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByText(/No contacts saved for this role yet/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Search contacts · free' }),
    ).toBeVisible();
    await expect(contactError).toHaveCount(0);
    await expect.poll(contactRead.attempts).toBeGreaterThan(1);
  } finally {
    for (const jobId of jobIds)
      await database.delete(jobs).where(eq(jobs.id, jobId));
  }
});
