import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDatabase, tasks, users, type Database } from '@career-workspace/db';
import { adminTaskRetry } from '@career-workspace/contracts';
import { ApiError } from './api';
import { recordEvent } from './events';

const retryableKinds = ['noop', 'cv_extract', 'contacts_search', 'account_delete', 'revoked_pdf_cleanup', 'job_discovery'] as const;
const taskIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function listFailedAdminTasks(database: Database = getDatabase()) {
  return database
    .select({
      id: tasks.id,
      userId: tasks.userId,
      kind: tasks.kind,
      status: tasks.status,
      attempts: tasks.attempts,
      error: tasks.error,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(eq(tasks.status, 'failed'))
    .orderBy(desc(tasks.updatedAt))
    .limit(100);
}

/** Requeues only free task kinds whose handlers safely tolerate retries. */
export async function retryFailedAdminTask(
  adminUserId: string,
  taskId: string,
  input: unknown,
  database: Database = getDatabase(),
) {
  if (!taskIdPattern.test(taskId))
    throw new ApiError(404, 'NOT_FOUND', 'Task not found.');
  const parsed = adminTaskRetry.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Enter a reason (8–500 characters).',
    );

  return database.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for('update');
    if (!task) throw new ApiError(404, 'NOT_FOUND', 'Task not found.');
    if (task.status !== 'failed')
      throw new ApiError(
        409,
        'TASK_NOT_FAILED',
        'Only failed tasks can be retried.',
      );
    if (!retryableKinds.includes(task.kind as (typeof retryableKinds)[number]))
      throw new ApiError(
        409,
        'UNSAFE_TASK_RETRY',
        'This task needs a provider-specific check before it can be retried.',
      );
    if (task.kind === 'account_delete') {
      const [owner] = await tx.select({ deletionRequestedAt: users.deletionRequestedAt }).from(users).where(eq(users.id, task.userId));
      if (!owner?.deletionRequestedAt) throw new ApiError(409, 'DELETION_NOT_REQUESTED', 'The account owner must request deletion before cleanup can be retried.');
    }

    const [queued] = await tx
      .update(tasks)
      .set({ status: 'queued', error: null, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'failed')))
      .returning({
        id: tasks.id,
        userId: tasks.userId,
        kind: tasks.kind,
        status: tasks.status,
      });
    if (!queued)
      throw new ApiError(
        409,
        'TASK_NOT_FAILED',
        'This task is already changing.',
      );

    await recordEvent(
      {
        userId: queued.userId,
        actorId: adminUserId,
        type: 'admin.task.retry_requested',
        subjectType: 'task',
        subjectId: queued.id,
        visibility: 'internal',
        data: {
          kind: queued.kind,
          reason: parsed.data.reason,
          previousAttempts: task.attempts,
        },
      },
      tx,
    );
    return queued;
  });
}

/** Puts a requeued task back in failed state if Vercel could not start it. */
export async function failAdminTaskDispatch(
  adminUserId: string,
  taskId: string,
  database: Database = getDatabase(),
) {
  return database.transaction(async (tx) => {
    const [task] = await tx
      .update(tasks)
      .set({
        status: 'failed',
        error: 'RETRY_DISPATCH_FAILED',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.status, 'queued'),
          inArray(tasks.kind, [...retryableKinds]),
        ),
      )
      .returning({ id: tasks.id, userId: tasks.userId, kind: tasks.kind });
    if (!task) return null;
    await recordEvent(
      {
        userId: task.userId,
        actorId: adminUserId,
        type: 'admin.task.retry_dispatch_failed',
        subjectType: 'task',
        subjectId: task.id,
        visibility: 'internal',
        data: { kind: task.kind },
      },
      tx,
    );
    return task;
  });
}
