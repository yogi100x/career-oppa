import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import {
  createDatabase,
  events,
  ledgerEntries,
  suppressions,
  tasks,
  users,
} from '@career-workspace/db';
import { createRefreshedBrowserContext, expect, test } from './fixtures';
import { USER_B_STORAGE_STATE } from './ownership.routes';

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

test('admin can add and remove suppressions and retry only a safe failed task', async ({
  page,
  browser,
}, testInfo) => {
  const url = process.env.DATABASE_TEST_URL;
  if (!url || new URL(url).pathname !== '/career_workspace_test')
    throw new Error('Use DATABASE_TEST_URL with career_workspace_test.');
  process.env.DATABASE_URL = url;
  const { database, pool } = createDatabase(url);
  const baseURL = testInfo.project.use.baseURL as string;
  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.status()).toBe(200);
  const admin = ((await meResponse.json()) as Envelope<{ id: string }>).data!;
  const bContext = await createRefreshedBrowserContext(
    browser, resolve('apps/web', USER_B_STORAGE_STATE), baseURL,
  );
  const bApi = bContext.page.request;
  let roleChanged = false;
  let taskIds: string[] = [];
  let suppressionId: string | undefined;
  let adjustmentKey: string | undefined;
  const email = `blocked-${randomUUID()}@example.invalid`;
  const reason = `Admin test block ${randomUUID()}`;
  const retryReason = `Provider check complete ${randomUUID()}`;

  try {
    await database
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, admin.id));
    roleChanged = true;

    const previousAdjustments = await database
      .select({ subjectId: events.subjectId, data: events.data })
      .from(events)
      .where(
        and(eq(events.userId, admin.id), eq(events.type, 'credits.adjusted')),
      );
    for (const event of previousAdjustments) {
      const eventData = event.data as { reason?: string } | null;
      if (eventData?.reason?.startsWith('Retry-safe adjustment ')) {
        await database
          .delete(events)
          .where(
            and(
              eq(events.userId, admin.id),
              eq(events.type, 'credits.adjusted'),
              eq(events.subjectId, event.subjectId),
            ),
          );
        await database
          .delete(ledgerEntries)
          .where(eq(ledgerEntries.id, event.subjectId));
      }
    }

    const bMeResponse = await bApi.get('/api/v1/me');
    expect(bMeResponse.status()).toBe(200);
    const bMe = (
      (await bMeResponse.json()) as Envelope<{ id: string }>
    ).data!;
    for (const response of await Promise.all([
      bApi.get('/api/v1/admin/tasks'),
      bApi.post('/api/v1/admin/suppressions', { data: { email, reason } }),
    ])) {
      expect(response.status()).toBe(403);
      expect(((await response.json()) as Envelope<never>).error?.code).toBe(
        'FORBIDDEN',
      );
    }

    const [safeTask] = await database
      .insert(tasks)
      .values({
        userId: admin.id,
        kind: 'noop',
        status: 'failed',
        attempts: 1,
        input: {},
        error: 'RECORDED_FAILURE',
        idempotencyKey: `admin-ui-retry:${randomUUID()}`,
      })
      .returning();
    const [unsafeTask] = await database
      .insert(tasks)
      .values({
        userId: admin.id,
        kind: 'publish_post',
        status: 'failed',
        attempts: 1,
        input: {},
        error: 'PROVIDER_OUTCOME_UNKNOWN',
        idempotencyKey: `admin-ui-publish:${randomUUID()}`,
      })
      .returning();
    taskIds = [safeTask.id, unsafeTask.id];

    await page.goto(`${baseURL}/admin/tasks`);
    await expect(
      page.getByRole('heading', { name: 'Failed tasks' }),
    ).toBeVisible();
    const safeRow = page.getByText(`Task ${safeTask.id}`).locator('..');
    await expect(page.getByText(`Task ${unsafeTask.id}`)).toBeVisible();
    await expect(
      page.getByText(
        'Retry disabled. Check the provider’s status and reconcile before retrying.',
      ),
    ).toBeVisible();
    const retryForm = safeRow
      .locator('..')
      .locator('..')
      .getByRole('textbox', { name: 'Reason for retry' });
    await retryForm.fill(retryReason);
    await safeRow
      .locator('..')
      .locator('..')
      .getByRole('button', { name: 'Retry task' })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Retry started.' }),
    ).toBeVisible();
    await expect(page.getByText(`Task ${safeTask.id}`)).toHaveCount(0);
    const [retryEvent] = await database
      .select()
      .from(events)
      .where(
        and(
          eq(events.subjectId, safeTask.id),
          eq(events.type, 'admin.task.retry_requested'),
        ),
      );
    expect(retryEvent).toMatchObject({
      actorId: admin.id,
      visibility: 'internal',
    });
    expect(retryEvent.data).toMatchObject({ reason: retryReason });

    await page.goto(`${baseURL}/admin/suppressions`);
    await expect(
      page.getByRole('heading', { name: 'Do-not-contact list' }),
    ).toBeVisible();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Reason').fill(reason);
    await page.getByRole('button', { name: 'Add to list' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'The email itself is not stored.' }),
    ).toBeVisible();
    await expect(page.getByText(reason)).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);
    const suppressionResponse = await page.request.get(
      '/api/v1/admin/suppressions',
    );
    const suppressionsBody = (await suppressionResponse.json()) as Envelope<
      Array<{ id: string; reason: string }>
    >;
    suppressionId = suppressionsBody.data?.find(
      (item) => item.reason === reason,
    )?.id;
    expect(suppressionId).toBeTruthy();
    const newSuppression = page
      .getByRole('listitem')
      .filter({ hasText: reason });
    await newSuppression.getByRole('button', { name: 'Remove block' }).click();
    await newSuppression
      .getByRole('button', { name: 'Confirm removal' })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Address removed.' }),
    ).toBeVisible();
    const suppressionAudit = await database
      .select()
      .from(events)
      .where(
        and(
          eq(events.subjectType, 'suppression'),
          eq(events.subjectId, suppressionId!),
        ),
      );
    expect(
      suppressionAudit.some(
        (event) =>
          event.type === 'suppression.added' && event.visibility === 'internal',
      ),
    ).toBe(true);
    expect(
      suppressionAudit.some(
        (event) =>
          event.type === 'suppression.removed' &&
          event.visibility === 'internal',
      ),
    ).toBe(true);

    const adjustmentReason = `Retry-safe adjustment ${randomUUID()}`;
    const requestKeys: string[] = [];
    let dropFirstResponse = true;
    await page.route('**/api/v1/admin/ledger-adjustments', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const key = route.request().headers()['idempotency-key'];
      if (key) requestKeys.push(key);
      if (dropFirstResponse) {
        dropFirstResponse = false;
        // Let the real admin API commit the adjustment, then make the browser
        // see a lost response. Retrying must reuse the same idempotency key.
        await route.fetch();
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'RESPONSE_LOST',
              message:
                'The result could not be confirmed. Retry the same request.',
            },
          }),
        });
      } else {
        await route.continue();
      }
    });
    await page.goto(`${baseURL}/admin/ledger-adjustments`);
    await page.getByLabel('User ID').fill(admin.id);
    await page.getByLabel('Credit bucket').selectOption('earned');
    await page.getByLabel('Signed amount').fill('2');
    await page.getByLabel('Reason').fill(adjustmentReason);
    await page.getByRole('button', { name: 'Save adjustment' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Retry the same request.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'This adjustment was already applied.' }),
    ).toBeVisible();
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    adjustmentKey = requestKeys[0];
    const ledgerIdempotencyKey = `admin-adjust:${admin.id}:${adjustmentKey}`;
    const adjustmentRows = await database
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.idempotencyKey, ledgerIdempotencyKey));
    expect(adjustmentRows).toHaveLength(1);
    expect(adjustmentRows[0]).toMatchObject({ amount: 2, bucket: 'earned' });
  } finally {
    if (taskIds.length) {
      await database
        .delete(events)
        .where(
          and(
            inArray(events.subjectId, taskIds),
            inArray(events.type, [
              'admin.task.retry_requested',
              'admin.task.retry_dispatch_failed',
            ]),
          ),
        );
      await database.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    if (!suppressionId) {
      const [createdSuppression] = await database
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(eq(suppressions.reason, reason));
      suppressionId = createdSuppression?.id;
    }
    if (suppressionId) {
      await database
        .delete(events)
        .where(
          and(
            eq(events.subjectType, 'suppression'),
            eq(events.subjectId, suppressionId),
          ),
        );
      await database
        .delete(suppressions)
        .where(eq(suppressions.id, suppressionId));
    }
    if (adjustmentKey) {
      const [entry] = await database
        .select()
        .from(ledgerEntries)
        .where(
          eq(
            ledgerEntries.idempotencyKey,
            `admin-adjust:${admin.id}:${adjustmentKey}`,
          ),
        );
      if (entry) {
        await database
          .delete(events)
          .where(
            and(
              eq(events.subjectType, 'ledger_entry'),
              eq(events.subjectId, entry.id),
            ),
          );
        await database
          .delete(ledgerEntries)
          .where(eq(ledgerEntries.id, entry.id));
      }
    }
    if (roleChanged)
      await database
        .update(users)
        .set({ role: 'candidate' })
        .where(eq(users.id, admin.id));
    await bContext.close();
    await pool.end();
  }
});
