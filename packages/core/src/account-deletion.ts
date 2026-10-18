import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  files,
  getDatabase,
  ledgerEntries,
  paymentEvents,
  paymentRefunds,
  payments,
  posts,
  publishingEvents,
  socialConnections,
  tasks,
  users,
  type Database,
} from '@career-workspace/db';
import {
  deleteZernioProfile,
  disconnectZernioAccount,
  ZernioError,
} from '@career-workspace/adapters/zernio';
import {
  getPrivateStorage,
  type PrivateStorage,
} from '@career-workspace/adapters/storage';
import { ApiError } from './api';
import { getTask } from './tasks';

const taskKind = 'account_delete';
const activeStatuses = ['queued', 'running', 'failed'] as const;

type DeletionProvider = {
  disconnectAccount: typeof disconnectZernioAccount;
  deleteProfile: typeof deleteZernioProfile;
};
type Options = {
  database?: Database;
  storage?: PrivateStorage;
  provider?: DeletionProvider;
  deleteIdentity?: (clerkId: string) => Promise<void>;
  now?: () => Date;
};

const zernio: DeletionProvider = {
  disconnectAccount: disconnectZernioAccount,
  deleteProfile: deleteZernioProfile,
};

function missingProviderResource(error: unknown) {
  return error instanceof ZernioError && error.status === 404;
}

/** Locks the user before setting the block and creating one durable cleanup task. */
export async function createAccountDeletionTask(
  userId: string,
  requestKey: string,
  database: Database = getDatabase(),
) {
  if (!requestKey.trim() || requestKey.length > 200)
    throw new ApiError(400, 'INVALID_INPUT', 'Provide a valid request key.');
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
    if (!user.deletionRequestedAt)
      await tx
        .update(users)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(users.id, userId));
    await tx
      .update(tasks)
      .set({
        status: 'failed',
        error: 'ACCOUNT_DELETION_PENDING',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.userId, userId),
          ne(tasks.kind, taskKind),
          inArray(tasks.status, ['queued', 'running']),
        ),
      );

    let [existing] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.kind, taskKind),
          inArray(tasks.status, [...activeStatuses]),
        ),
      )
      .orderBy(tasks.createdAt)
      .limit(1);
    if (
      existing?.status === 'running' &&
      Date.now() - existing.updatedAt.getTime() >= 120_000
    ) {
      [existing] = await tx
        .update(tasks)
        .set({
          status: 'failed',
          error: 'ACCOUNT_DELETION_RETRY',
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, existing.id))
        .returning();
    }
    if (existing) return existing;

    const idempotencyKey = `task:${userId}:account-delete:${requestKey}`;
    const [sameRequest] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.idempotencyKey, idempotencyKey))
      .limit(1);
    if (sameRequest) return sameRequest;

    const [created] = await tx
      .insert(tasks)
      .values({ userId, kind: taskKind, input: {}, idempotencyKey })
      .returning();
    return created;
  });
}

async function updateStage(
  userId: string,
  taskId: string,
  stage: string,
  database: Database,
) {
  await database
    .update(tasks)
    .set({ output: { stage }, updatedAt: new Date() })
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)));
}

/** Performs idempotent external cleanup before removing the local account. */
export async function runAccountDeletionTask(
  userId: string,
  taskId: string,
  options: Options = {},
) {
  const database = options.database ?? getDatabase();
  const storage = options.storage ?? getPrivateStorage();
  const provider = options.provider ?? zernio;
  const now = options.now ?? (() => new Date());
  const [existingUser] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // Workflow step retries can arrive after the successful step result was
  // persisted but before the runner recorded its completion. The user row is
  // deleted only after all external cleanup, so absence is a safe replay.
  if (!existingUser) return { deleted: true };
  const task = await getTask(userId, taskId, database);
  if (task.kind !== taskKind)
    throw new ApiError(
      400,
      'INVALID_TASK',
      'This is not an account deletion task.',
    );
  if (task.status === 'succeeded') return { deleted: true };

  const claimed = await database.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
      .for('update');
    if (
      !locked ||
      !activeStatuses.includes(locked.status as (typeof activeStatuses)[number])
    )
      return null;
    if (
      locked.status === 'running' &&
      now().getTime() - locked.updatedAt.getTime() < 120_000
    )
      throw new ApiError(
        409,
        'TASK_NOT_READY',
        'This account deletion is already running.',
      );
    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'running',
        attempts: sql`${tasks.attempts} + 1`,
        error: null,
        updatedAt: now(),
      })
      .where(eq(tasks.id, taskId))
      .returning();
    return updated;
  });
  if (!claimed)
    throw new ApiError(
      409,
      'TASK_NOT_READY',
      'This account deletion is already complete or running.',
    );

  let stage = 'load_account';
  try {
    const [user] = await database
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return { deleted: true };
    if (!user.deletionRequestedAt)
      throw new ApiError(
        409,
        'DELETION_NOT_REQUESTED',
        'Account deletion was not requested.',
      );

    const [connection] = await database
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, userId))
      .limit(1);
    if (connection?.providerAccountId) {
      stage = 'disconnect_provider_account';
      await updateStage(userId, taskId, stage, database);
      try {
        await provider.disconnectAccount(connection.providerAccountId);
      } catch (error) {
        if (!missingProviderResource(error)) throw error;
      }
    }
    if (connection?.providerProfileId) {
      stage = 'delete_provider_profile';
      await updateStage(userId, taskId, stage, database);
      try {
        await provider.deleteProfile(connection.providerProfileId);
      } catch (error) {
        if (!missingProviderResource(error)) throw error;
      }
    }

    stage = 'delete_private_files';
    await updateStage(userId, taskId, stage, database);
    const ownedFiles = await database
      .select({ id: files.id, r2Key: files.r2Key })
      .from(files)
      .where(eq(files.userId, userId));
    for (const file of ownedFiles) await storage.delete(file.r2Key);

    if (!options.deleteIdentity)
      throw new ApiError(
        503,
        'IDENTITY_DELETE_NOT_CONFIGURED',
        'Identity cleanup is not configured yet.',
      );

    stage = 'delete_local_account';
    await updateStage(userId, taskId, stage, database);
    await database.transaction(async (tx) => {
      const [lockedUser] = await tx
        .select({
          id: users.id,
          clerkId: users.clerkId,
          deletionRequestedAt: users.deletionRequestedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!lockedUser) return;
      if (!lockedUser.deletionRequestedAt)
        throw new ApiError(
          409,
          'DELETION_NOT_REQUESTED',
          'Account deletion was not requested.',
        );
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockedUser.clerkId}, 0))`,
      );
      stage = 'delete_clerk_identity';
      await updateStage(userId, taskId, stage, database);
      try {
        await options.deleteIdentity!(lockedUser.clerkId);
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'status' in error
            ? error.status
            : undefined;
        const statusCode =
          error && typeof error === 'object' && 'statusCode' in error
            ? error.statusCode
            : undefined;
        if (status !== 404 && statusCode !== 404) throw error;
      }

      const ownedPayments = await tx
        .select({ providerPaymentId: payments.providerPaymentId })
        .from(payments)
        .where(eq(payments.userId, userId));
      const paymentIds = ownedPayments.map(
        (payment) => payment.providerPaymentId,
      );
      const ownedRefunds = await tx
        .select({ providerRefundId: paymentRefunds.providerRefundId })
        .from(paymentRefunds)
        .where(eq(paymentRefunds.userId, userId));
      const refundIds = ownedRefunds.map((refund) => refund.providerRefundId);
      const ownedPosts = await tx
        .select({ providerPostId: posts.providerPostId })
        .from(posts)
        .where(eq(posts.userId, userId));
      const providerPostIds = ownedPosts.flatMap((post) =>
        post.providerPostId ? [post.providerPostId] : [],
      );

      await tx
        .update(ledgerEntries)
        .set({ userId: null, idempotencyKey: null })
        .where(eq(ledgerEntries.userId, userId));
      const paymentEventConditions = [eq(paymentEvents.userId, userId)];
      if (paymentIds.length)
        paymentEventConditions.push(
          inArray(paymentEvents.paymentId, paymentIds),
        );
      if (refundIds.length)
        paymentEventConditions.push(inArray(paymentEvents.refundId, refundIds));
      await tx.delete(paymentEvents).where(or(...paymentEventConditions));
      const refundConditions = [eq(paymentRefunds.userId, userId)];
      if (paymentIds.length)
        refundConditions.push(
          inArray(paymentRefunds.providerPaymentId, paymentIds),
        );
      if (refundIds.length)
        refundConditions.push(
          inArray(paymentRefunds.providerRefundId, refundIds),
        );
      await tx.delete(paymentRefunds).where(or(...refundConditions));
      await tx.delete(payments).where(eq(payments.userId, userId));
      if (providerPostIds.length)
        await tx
          .delete(publishingEvents)
          .where(inArray(publishingEvents.providerPostId, providerPostIds));
      await tx.delete(files).where(eq(files.userId, userId));
      await tx
        .delete(users)
        .where(
          and(
            eq(users.id, userId),
            sql`${users.deletionRequestedAt} IS NOT NULL`,
          ),
        );
    });
    return { deleted: true };
  } catch {
    await database
      .update(tasks)
      .set({
        status: 'failed',
        error: 'ACCOUNT_DELETION_RETRY',
        output: { stage },
        updatedAt: now(),
      })
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.id, taskId),
          eq(tasks.status, 'running'),
        ),
      )
      .catch(() => undefined);
    throw new ApiError(
      503,
      'ACCOUNT_DELETION_RETRY',
      'Account cleanup could not finish. This account is blocked while cleanup is retried.',
    );
  }
}

export async function getAccountDeletionStatus(
  userId: string,
  database: Database = getDatabase(),
) {
  const [user] = await database
    .select({ deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  if (!user.deletionRequestedAt) return null;
  const [task] = await database
    .select({
      id: tasks.id,
      status: tasks.status,
      error: tasks.error,
      output: tasks.output,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.kind, taskKind)))
    .orderBy(tasks.createdAt)
    .limit(1);
  const stale =
    task?.status === 'running' &&
    Date.now() - task.updatedAt.getTime() >= 120_000;
  const stage =
    task?.output && typeof task.output.stage === 'string'
      ? task.output.stage
      : null;
  return {
    taskId: task?.id ?? null,
    status: stale ? 'failed' : (task?.status ?? 'running'),
    stage,
    error: stale ? 'ACCOUNT_DELETION_RETRY' : (task?.error ?? null),
  };
}

export async function markAccountDeletionDispatchFailed(
  userId: string,
  taskId: string,
  database: Database = getDatabase(),
) {
  await database
    .update(tasks)
    .set({
      status: 'failed',
      error: 'WORKFLOW_START_FAILED',
      output: { stage: 'start_cleanup' },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.id, taskId),
        eq(tasks.kind, taskKind),
        inArray(tasks.status, ['queued', 'running']),
      ),
    );
}
