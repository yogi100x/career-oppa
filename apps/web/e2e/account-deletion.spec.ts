import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import {
  closeDatabase,
  files,
  getDatabase,
  ledgerEntries,
  users,
} from '@career-workspace/db';
import { LocalFolderStorage } from '@career-workspace/adapters/storage';
import { clerkClient } from '@clerk/nextjs/server';
import { createRefreshedBrowserContext } from './fixtures';

const screenshotDir = 'output';
const testStorage = new LocalFolderStorage(resolve('apps/web/.local-storage'));

test('account deletion confirms, removes fixture C, and keeps the UI clear', async ({
  browser,
  baseURL,
}) => {
  const authDirectory = resolve('apps/web/e2e/.auth');
  const fixturesPath = resolve(authDirectory, 'users.json');
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8')) as {
    userC?: { clerkId: string };
  };
  const clerkId = fixtures.userC?.clerkId;
  if (!clerkId || !baseURL) throw new Error('Deletion fixture C is missing.');
  const fixture = await createRefreshedBrowserContext(
    browser,
    resolve(authDirectory, 'user-c.json'),
    baseURL,
  );
  const { page } = fixture;
  try {
    await page.goto('/workspace/profile');
    const section = page.getByRole('region', { name: 'Delete your account' });
    await expect(section).toBeVisible();
    const confirmation = page.getByLabel('Type DELETE to confirm.');
    const submit = section.getByRole('button', { name: 'Delete account' });
    await expect(submit).toBeDisabled();
    await confirmation.fill('delete');
    await expect(submit).toBeDisabled();
    await confirmation.fill('DELETE');
    await expect(submit).toBeEnabled();
    await page.screenshot({
      path: `${screenshotDir}/account-deletion-desktop.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(
      page.getByRole('region', { name: 'Delete your account' }),
    ).toBeVisible();
    await page.screenshot({
      path: `${screenshotDir}/account-deletion-phone.png`,
      fullPage: true,
    });

    const upload = await page.evaluate(async () => {
      const form = new FormData();
      form.set(
        'file',
        new File(
          [new TextEncoder().encode('%PDF-1.4 private deletion fixture')],
          'private-deletion-fixture.pdf',
          {
            type: 'application/pdf',
          },
        ),
      );
      const response = await fetch('/api/v1/files', {
        method: 'POST',
        body: form,
      });
      return { status: response.status, body: await response.json() };
    });
    expect(upload.status).toBe(201);
    const uploadBody = upload.body as { data: { id: string } };
    const database = getDatabase();
    const [owner] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);
    expect(owner).toBeDefined();
    const [privateFile] = await database
      .select({ id: files.id, r2Key: files.r2Key })
      .from(files)
      .where(and(eq(files.id, uploadBody.data.id), eq(files.userId, owner!.id)))
      .limit(1);
    expect(privateFile).toBeDefined();
    expect(await testStorage.get(privateFile!.r2Key)).not.toBeNull();
    const [ledgerEntry] = await database
      .insert(ledgerEntries)
      .values({
        userId: owner!.id,
        amount: 12,
        bucket: 'earned',
        kind: 'grant',
        idempotencyKey: `delete-e2e:${randomUUID()}`,
      })
      .returning({ id: ledgerEntries.id });

    await page.getByLabel('Type DELETE to confirm.').fill('DELETE');
    const deletionResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/account/deletion') &&
        response.request().method() === 'POST',
    );
    await fixture.stopSessionRefresh();
    await page.getByRole('button', { name: 'Delete account' }).click();
    expect((await deletionResponse).status()).toBe(200);
    await expect(page.getByRole('status')).toContainText(
      'Deletion started. You’ll be signed out when cleanup finishes.',
    );
    await page.screenshot({
      path: `${screenshotDir}/account-deletion-phone-started.png`,
      fullPage: true,
    });

    await expect
      .poll(
        async () => {
          const database = getDatabase();
          const [user] = await database
            .select({ id: users.id })
            .from(users)
            .where(eq(users.clerkId, clerkId))
            .limit(1);
          return Boolean(user);
        },
        { timeout: 60_000 },
      )
      .toBe(false);
    const [anonymizedLedgerEntry] = await getDatabase()
      .select({
        userId: ledgerEntries.userId,
        idempotencyKey: ledgerEntries.idempotencyKey,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, ledgerEntry!.id))
      .limit(1);
    expect(anonymizedLedgerEntry).toEqual({
      userId: null,
      idempotencyKey: null,
    });
    expect(await testStorage.get(privateFile!.r2Key)).toBeNull();
    let identityExists = true;
    try {
      await (await clerkClient()).users.getUser(clerkId);
    } catch (error) {
      const status =
        (error as { status?: number; statusCode?: number }).status ??
        (error as { statusCode?: number }).statusCode;
      if (status === 404) identityExists = false;
      else throw error;
    }
    expect(identityExists).toBe(false);
  } finally {
    await fixture.close();
    await closeDatabase();
  }
});
