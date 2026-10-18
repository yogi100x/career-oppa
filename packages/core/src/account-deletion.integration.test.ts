import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  files,
  ledgerEntries,
  paymentEvents,
  paymentRefunds,
  payments,
  socialConnections,
  tasks,
  users,
  type Database,
} from '@career-workspace/db';
import type { PrivateStorage } from '@career-workspace/adapters/storage';
import { createUserFile } from './files';
import { reserve } from './credits';
import { createTask, startTask } from './tasks';
import {
  createAccountDeletionTask,
  getAccountDeletionStatus,
  runAccountDeletionTask,
} from './account-deletion';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('account deletion', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  const clerkIds: string[] = [];

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    ({ database: db, pool } = createDatabase(testDatabaseUrl!));
  });
  afterAll(async () => {
    for (const clerkId of clerkIds)
      await db.delete(users).where(eq(users.clerkId, clerkId));
    await pool.end();
  });

  async function makeUser() {
    const clerkId = `delete-test-${randomUUID()}`;
    clerkIds.push(clerkId);
    const [user] = await db
      .insert(users)
      .values({ clerkId, ageConfirmedAt: new Date() })
      .returning();
    return user;
  }

  function fakeStorage(
    shouldFail?: () => boolean,
  ): PrivateStorage & { content: Map<string, Uint8Array> } {
    const content = new Map<string, Uint8Array>();
    return {
      content,
      async put(key, value) {
        content.set(key, value);
      },
      async get(key) {
        return content.get(key) ?? null;
      },
      async delete(key) {
        if (shouldFail?.()) throw new Error('storage unavailable');
        content.delete(key);
      },
    };
  }

  it('anonymizes ledger history and removes private files, billing links and provider records', async () => {
    const user = await makeUser();
    const storage = fakeStorage();
    const fileId = randomUUID();
    const r2Key = `files/${fileId}.blob`;
    storage.content.set(r2Key, new TextEncoder().encode('%PDF-1.4 private cv'));
    const [file] = await db
      .insert(files)
      .values({
        userId: user.id,
        r2Key,
        kind: 'cv_upload',
        originalName: 'cv.pdf',
        contentType: 'application/pdf',
        size: 19,
      })
      .returning();
    const idempotencyKey = `private-credit-${randomUUID()}`;
    const [entry] = await db
      .insert(ledgerEntries)
      .values({
        userId: user.id,
        amount: 30,
        bucket: 'purchased',
        kind: 'purchase',
        idempotencyKey,
      })
      .returning();
    const providerPaymentId = `payment-${randomUUID()}`;
    const providerRefundId = `refund-${randomUUID()}`;
    await db.insert(payments).values({
      userId: user.id,
      providerPaymentId,
      packId: 'starter',
      productId: 'starter-product',
      credits: 30,
      amountMinor: 500,
      currency: 'GBP',
    });
    await db.insert(paymentRefunds).values({
      userId: user.id,
      providerRefundId,
      providerPaymentId,
      isPartial: false,
      amountMinor: 500,
      currency: 'GBP',
      status: 'applied',
    });
    await db.insert(paymentEvents).values({
      userId: user.id,
      webhookId: `webhook-${randomUUID()}`,
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      refundId: providerRefundId,
      payload: { email: 'private@example.test' },
    });
    const accountId = `account-${randomUUID()}`;
    const profileId = `profile-${randomUUID()}`;
    await db.insert(socialConnections).values({
      userId: user.id,
      providerAccountId: accountId,
      providerProfileId: profileId,
      platform: 'linkedin',
      status: 'connected',
    });
    const task = await createAccountDeletionTask(user.id, randomUUID(), db);
    expect(task.status).toBe('queued');
    expect(await getAccountDeletionStatus(user.id, db)).toMatchObject({
      status: 'queued',
    });

    const disconnectAccount = vi.fn(async (value: string) =>
      expect(value).toBe(accountId),
    );
    const deleteProfile = vi.fn(async (value: string) =>
      expect(value).toBe(profileId),
    );
    const deleteIdentity = vi.fn(async (value: string) =>
      expect(value).toBe(user.clerkId),
    );
    expect(
      await runAccountDeletionTask(user.id, task.id, {
        database: db,
        storage,
        provider: { disconnectAccount, deleteProfile },
        deleteIdentity,
      }),
    ).toEqual({ deleted: true });
    expect(disconnectAccount).toHaveBeenCalledOnce();
    expect(deleteProfile).toHaveBeenCalledOnce();
    expect(deleteIdentity).toHaveBeenCalledOnce();
    expect(
      await runAccountDeletionTask(user.id, task.id, {
        database: db,
        storage,
        provider: { disconnectAccount, deleteProfile },
        deleteIdentity,
      }),
    ).toEqual({ deleted: true });
    expect(disconnectAccount).toHaveBeenCalledOnce();
    expect(deleteProfile).toHaveBeenCalledOnce();
    expect(deleteIdentity).toHaveBeenCalledOnce();
    expect(storage.content.has(r2Key)).toBe(false);
    expect(
      await db.select().from(users).where(eq(users.id, user.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(files).where(eq(files.id, file.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(payments)
        .where(eq(payments.providerPaymentId, providerPaymentId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.providerRefundId, providerRefundId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, providerPaymentId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(socialConnections)
        .where(eq(socialConnections.userId, user.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(tasks).where(eq(tasks.id, task.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.id, entry.id)),
    ).toMatchObject([
      {
        userId: null,
        idempotencyKey: null,
        amount: 30,
        bucket: 'purchased',
        kind: 'purchase',
      },
    ]);
  });

  it('leaves a blocked account and a retryable task when file cleanup fails', async () => {
    const user = await makeUser();
    const storage = fakeStorage();
    const key = `files/${randomUUID()}.blob`;
    storage.content.set(key, new Uint8Array([1]));
    await db.insert(files).values({
      userId: user.id,
      r2Key: key,
      kind: 'cv_upload',
      originalName: 'cv.pdf',
      contentType: 'application/pdf',
      size: 1,
    });
    const task = await createAccountDeletionTask(user.id, randomUUID(), db);
    const failOnce = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const retryStorage = fakeStorage(failOnce);
    retryStorage.content.set(key, new Uint8Array([1]));
    const provider = { disconnectAccount: vi.fn(), deleteProfile: vi.fn() };
    const deleteIdentity = vi.fn();
    await expect(
      runAccountDeletionTask(user.id, task.id, {
        database: db,
        storage: retryStorage,
        provider,
        deleteIdentity,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_RETRY', status: 503 });
    expect(
      await db.select().from(users).where(eq(users.id, user.id)),
    ).toMatchObject([{ deletionRequestedAt: expect.any(Date) }]);
    expect(await getAccountDeletionStatus(user.id, db)).toMatchObject({
      status: 'failed',
      error: 'ACCOUNT_DELETION_RETRY',
      stage: 'delete_private_files',
    });
    expect(deleteIdentity).not.toHaveBeenCalled();

    const retryTask = await createAccountDeletionTask(
      user.id,
      randomUUID(),
      db,
    );
    expect(retryTask.id).toBe(task.id);
    expect(
      await runAccountDeletionTask(user.id, task.id, {
        database: db,
        storage: retryStorage,
        provider,
        deleteIdentity: async () => undefined,
      }),
    ).toEqual({ deleted: true });
    expect(
      await db.select().from(users).where(eq(users.id, user.id)),
    ).toHaveLength(0);
  });

  it('cancels queued tasks before starting deletion', async () => {
    const user = await makeUser();
    const [pending] = await db
      .insert(tasks)
      .values({
        userId: user.id,
        kind: 'cv_extract',
        input: {},
        idempotencyKey: `task:${user.id}:pending-${randomUUID()}`,
      })
      .returning();
    const deletion = await createAccountDeletionTask(user.id, randomUUID(), db);
    expect(deletion.kind).toBe('account_delete');
    expect(
      await db.select().from(users).where(eq(users.id, user.id)),
    ).toMatchObject([{ deletionRequestedAt: expect.any(Date) }]);
    expect(
      await db.select().from(tasks).where(eq(tasks.id, pending.id)),
    ).toMatchObject([
      expect.objectContaining({
        status: 'failed',
        error: 'ACCOUNT_DELETION_PENDING',
      }),
    ]);
    await expect(
      createTask(user.id, 'contacts_search', randomUUID(), {}, db),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
    await expect(startTask(user.id, pending.id, db)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_PENDING',
    });
    await expect(
      reserve(user.id, 'post_draft', randomUUID(), { database: db }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
    const storage = fakeStorage();
    await expect(
      createUserFile(
        user.id,
        {
          kind: 'cv_upload',
          originalName: 'cv.pdf',
          contents: new TextEncoder().encode('%PDF-1.4'),
        },
        { database: db, storage },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
    expect(storage.content.size).toBe(0);
  });
});
