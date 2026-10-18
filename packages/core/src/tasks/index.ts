import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDatabase, tasks, users, type Database } from '@career-workspace/db';
import { ApiError } from '../api';

export async function getTask(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  const [task] = await database
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, id)));
  if (!task) throw new ApiError(404, 'NOT_FOUND', 'Task not found.');
  return task;
}
export async function createTask(
  userId: string,
  kind: string,
  key: string,
  input: Record<string, unknown> = {},
  database: Database = getDatabase(),
) {
  if (!kind.trim() || !key.trim() || key.length > 200)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Provide a task kind and request key.',
    );
  const idempotencyKey = `task:${userId}:${key}`;
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
    if (user.deletionRequestedAt)
      throw new ApiError(
        403,
        'ACCOUNT_DELETION_PENDING',
        'Account deletion is in progress.',
      );
    const [created] = await tx
      .insert(tasks)
      .values({ userId, kind, input, idempotencyKey })
      .onConflictDoNothing()
      .returning();
    const task =
      created ??
      (
        await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.userId, userId),
              eq(tasks.idempotencyKey, idempotencyKey),
            ),
          )
      )[0];
    if (!task || task.kind !== kind)
      throw new ApiError(
        409,
        'REQUEST_KEY_CONFLICT',
        'This request key belongs to another task.',
      );
    return task;
  });
}
export async function startTask(
  userId: string,
  id: string,
  database: Database = getDatabase(),
  options: { allowDeletionPending?: boolean } = {},
) {
  await getTask(userId, id, database);
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
    if (user.deletionRequestedAt && !options.allowDeletionPending)
      throw new ApiError(
        403,
        'ACCOUNT_DELETION_PENDING',
        'Account deletion is in progress.',
      );
    const [task] = await tx
      .update(tasks)
      .set({
        status: 'running',
        attempts: sql`${tasks.attempts} + 1`,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.id, id),
          inArray(tasks.status, ['queued', 'failed']),
        ),
      )
      .returning();
    if (!task)
      throw new ApiError(
        409,
        'TASK_NOT_READY',
        'This task is already running or finished.',
      );
    return task;
  });
}
export async function succeedTask(
  userId: string,
  id: string,
  output: Record<string, unknown>,
  database: Database = getDatabase(),
) {
  await getTask(userId, id, database);
  const [task] = await database
    .update(tasks)
    .set({ status: 'succeeded', output, error: null, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.id, id),
        eq(tasks.status, 'running'),
      ),
    )
    .returning();
  if (!task)
    throw new ApiError(
      409,
      'TASK_NOT_RUNNING',
      'Only a running task can finish.',
    );
  return task;
}
export async function failTask(
  userId: string,
  id: string,
  errorCode: string,
  database: Database = getDatabase(),
) {
  if (!/^[A-Z_0-9]{1,64}$/.test(errorCode))
    throw new ApiError(400, 'INVALID_INPUT', 'Use a safe error code.');
  await getTask(userId, id, database);
  const [task] = await database
    .update(tasks)
    .set({ status: 'failed', error: errorCode, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.id, id),
        eq(tasks.status, 'running'),
      ),
    )
    .returning();
  if (!task)
    throw new ApiError(
      409,
      'TASK_NOT_RUNNING',
      'Only a running task can fail.',
    );
  return task;
}
/** Local foundation check. Workflow will call the same plain functions in milestone 3. */
export async function runNoOp(
  userId: string,
  key: string,
  database: Database = getDatabase(),
) {
  const task = await createTask(userId, 'noop', key, {}, database);
  return runNoOpTask(userId, task.id, database);
}

/** Plain task body shared by local checks and the durable Workflow wrapper. */
export async function runNoOpTask(
  userId: string,
  taskId: string,
  database: Database = getDatabase(),
) {
  const task = await getTask(userId, taskId, database);
  if (task.kind !== 'noop')
    throw new ApiError(400, 'INVALID_INPUT', 'This is not a no-op task.');
  if (task.status === 'succeeded') return task;
  await startTask(userId, taskId, database);
  return succeedTask(userId, taskId, { noop: true }, database);
}
