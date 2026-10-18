import { eq } from 'drizzle-orm';
import { createDatabase, users } from '@career-workspace/db';
import { expect, test } from './fixtures';

test('workspace and admin lists recover after a temporary read failure', async ({
  page,
}) => {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  )
    throw new Error('Use the isolated browser test database.');
  const { database, pool } = createDatabase(databaseUrl);
  let roleChanged = false;

  try {
    let releaseProfileRequest!: () => void;
    let markProfileRequestStarted!: () => void;
    const profileRequestGate = new Promise<void>((resolve) => {
      releaseProfileRequest = resolve;
    });
    const profileRequestStarted = new Promise<void>((resolve) => {
      markProfileRequestStarted = resolve;
    });
    let profileAttempts = 0;
    let profileRetryAllowed = false;
    await page.route('**/api/v1/profile/facts', async (route) => {
      profileAttempts += 1;
      if (!profileRetryAllowed) {
        markProfileRequestStarted();
        await profileRequestGate;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'TEMPORARY_FAILURE',
              message: 'Temporary profile read failed.',
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/workspace/profile');
    await profileRequestStarted;
    await expect(
      page.getByText('Loading your facts…', { exact: true }),
    ).toBeVisible();
    releaseProfileRequest();
    const profileError = page
      .locator('main')
      .getByRole('alert')
      .filter({ hasText: 'We could not load your profile. Please try again.' });
    await expect(profileError).toBeVisible();
    const attemptsBeforeRetry = profileAttempts;
    profileRetryAllowed = true;
    await profileError.getByRole('button', { name: 'Try again' }).click();
    await expect(profileError).toHaveCount(0);
    await expect
      .poll(() => profileAttempts)
      .toBeGreaterThan(attemptsBeforeRetry);

    const meResponse = await page.request.get('/api/v1/me');
    expect(meResponse.status()).toBe(200);
    const me = (await meResponse.json()) as { data?: { id: string } };
    if (!me.data?.id) throw new Error('The browser user was not loaded.');
    await database
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, me.data.id));
    roleChanged = true;

    let releaseAdminRequest!: () => void;
    let markAdminRequestStarted!: () => void;
    const adminRequestGate = new Promise<void>((resolve) => {
      releaseAdminRequest = resolve;
    });
    const adminRequestStarted = new Promise<void>((resolve) => {
      markAdminRequestStarted = resolve;
    });
    let adminAttempts = 0;
    let adminRetryAllowed = false;
    await page.route('**/api/v1/admin/suppressions', async (route) => {
      adminAttempts += 1;
      if (!adminRetryAllowed) {
        markAdminRequestStarted();
        await adminRequestGate;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'TEMPORARY_FAILURE',
              message: 'Temporary admin list failed.',
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/admin/suppressions');
    await adminRequestStarted;
    await expect(page.getByRole('status')).toContainText('Loading the list…');
    releaseAdminRequest();
    const adminError = page.getByText('Temporary admin list failed.', {
      exact: true,
    });
    await expect(adminError).toBeVisible();
    const adminAttemptsBeforeRetry = adminAttempts;
    adminRetryAllowed = true;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(adminError).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Blocked addresses' }),
    ).toBeVisible();
    await expect
      .poll(() => adminAttempts)
      .toBeGreaterThan(adminAttemptsBeforeRetry);
  } finally {
    if (roleChanged) {
      const meResponse = await page.request.get('/api/v1/me').catch(() => null);
      const me = meResponse?.ok()
        ? ((await meResponse.json()) as { data?: { id: string } }).data
        : undefined;
      if (me?.id)
        await database
          .update(users)
          .set({ role: 'candidate' })
          .where(eq(users.id, me.id));
    }
    await pool.end();
  }
});
