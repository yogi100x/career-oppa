import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createRefreshedBrowserContext, expect, test } from './fixtures';
import { and, eq } from 'drizzle-orm';
import { createDatabase, events, ledgerEntries, rewardSubmissions, users } from '@career-workspace/db';
import { USER_B_STORAGE_STATE } from './ownership.routes';

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

test('real admin role can review rewards and adjust credits while candidate admin APIs stay forbidden', async ({ page, browser }, testInfo) => {
  const testDatabaseUrl = process.env.DATABASE_TEST_URL;
  if (!testDatabaseUrl || new URL(testDatabaseUrl).pathname !== '/career_workspace_test')
    throw new Error('Set DATABASE_TEST_URL to the isolated career_workspace_test database.');
  process.env.DATABASE_URL = testDatabaseUrl;
  const { database, pool } = createDatabase(testDatabaseUrl);
  const baseURL = testInfo.project.use.baseURL as string;
  const userAResponse = await page.request.get(`${baseURL}/api/v1/me`);
  expect(userAResponse.status()).toBe(200);
  const userA = ((await userAResponse.json()) as Envelope<{ id: string }>).data!;
  const bContext = await createRefreshedBrowserContext(browser, resolve('apps/web', USER_B_STORAGE_STATE), baseURL);
  const bApi = bContext.page.request;
  let submissionId: string | undefined;
  let adminRoleChanged = false;
  const postUrl = `https://example.com/reward-test/${randomUUID()}`;
  const adjustmentReason = `Browser verified admin adjustment ${randomUUID()}.`;
  try {
    const bMe = await bApi.get('/api/v1/me');
    expect(bMe.status()).toBe(200);
    const bUser = ((await bMe.json()) as Envelope<{ id: string }>).data!;
    const denied = await Promise.all([
      bApi.get('/api/v1/admin/rewards'),
      bApi.patch(`/api/v1/admin/rewards/${randomUUID()}`, { data: { decision: 'approve' } }),
      bApi.get('/api/v1/admin/users?q=some-user'),
      bApi.post('/api/v1/admin/ledger-adjustments', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: { userId: bUser.id, bucket: 'earned', amount: 1, reason: 'Should be forbidden.' },
      }),
    ]);
    for (const response of denied) {
      expect(response.status()).toBe(403);
      expect(((await response.json()) as Envelope<never>).error?.code).toBe('FORBIDDEN');
    }

    await database.update(users).set({ role: 'admin' }).where(eq(users.id, userA.id));
    adminRoleChanged = true;
    const submitted = await page.request.post(`${baseURL}/api/v1/rewards`, {
      data: { url: postUrl, disclosureConfirmed: true },
    });
    expect(submitted.status()).toBe(200);
    submissionId = ((await submitted.json()) as Envelope<{ id: string }>).data!.id;

    await page.goto(`${baseURL}/admin/rewards`);
    await expect(page.getByRole('heading', { name: 'Reward review queue' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open submitted post' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve · 10 credits' }).click();
    await expect(page.getByRole('status')).toContainText('10 earned credits were added.');

    const lookup = await page.request.get(`${baseURL}/api/v1/admin/users?q=${encodeURIComponent(userA.id)}`);
    expect(lookup.status()).toBe(200);
    expect((await lookup.json() as Envelope<Array<{ id: string; role: string }>>).data?.some((entry) => entry.id === userA.id && entry.role === 'admin')).toBe(true);

    await page.goto(`${baseURL}/admin/ledger-adjustments`);
    await page.getByLabel('User ID').fill(userA.id);
    await page.getByLabel('Signed amount').fill('2');
    await page.getByLabel('Reason').fill(adjustmentReason);
    await page.getByRole('button', { name: 'Save adjustment' }).click();
    await expect(page.getByRole('status')).toContainText('Credit adjustment saved and recorded.');

    const [approved] = await database.select().from(rewardSubmissions).where(eq(rewardSubmissions.id, submissionId));
    expect(approved?.status).toBe('approved');
    const rewardEntries = await database.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `reward:${submissionId}`));
    expect(rewardEntries).toHaveLength(1);
    expect(rewardEntries[0]?.amount).toBe(10);
  } finally {
    if (submissionId) {
      await database.delete(events).where(and(eq(events.subjectType, 'reward_submission'), eq(events.subjectId, submissionId)));
      await database.delete(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `reward:${submissionId}`));
      await database.delete(rewardSubmissions).where(eq(rewardSubmissions.id, submissionId));
    }
    const adjustmentAudits = await database.select().from(events).where(and(eq(events.userId, userA.id), eq(events.type, 'credits.adjusted')));
    const adjustmentAudit = adjustmentAudits.find((event) => (event.data as Record<string, unknown>).reason === adjustmentReason);
    if (adjustmentAudit) {
      await database.delete(ledgerEntries).where(eq(ledgerEntries.id, adjustmentAudit.subjectId));
      await database.delete(events).where(eq(events.id, adjustmentAudit.id));
    }
    if (adminRoleChanged) await database.update(users).set({ role: 'candidate' }).where(eq(users.id, userA.id));
    await bContext.close();
    await pool.end();
  }
});
