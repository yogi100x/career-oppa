import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, events, tasks, users } from '@career-workspace/db';
import { and, eq } from 'drizzle-orm';
import {
  failAdminTaskDispatch,
  listFailedAdminTasks,
  retryFailedAdminTask,
} from './admin-tasks';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('admin failed task handling', () => {
  const { database, pool } = createDatabase(url!);
  const userIds: string[] = [];
  async function user(role: 'candidate' | 'admin') {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const [record] = await database
      .insert(users)
      .values({ clerkId: `admin-tasks-${randomUUID()}`, role })
      .returning();
    userIds.push(record.id);
    return record.id;
  }
  async function failedTask(userId: string, kind: string) {
    const [task] = await database
      .insert(tasks)
      .values({
        userId,
        kind,
        status: 'failed',
        attempts: 1,
        input: {},
        error: 'RECORDED_FAILURE',
        idempotencyKey: `admin-task-${randomUUID()}`,
      })
      .returning();
    return task;
  }
  afterAll(async () => {
    for (const id of userIds)
      await database.delete(users).where(eq(users.id, id));
    await pool.end();
  });

  it('requeues a safe failed search once and records an internal event with reason', async () => {
    const adminId = await user('admin');
    const ownerId = await user('candidate');
    const task = await failedTask(ownerId, 'contacts_search');
    const queued = await retryFailedAdminTask(
      adminId,
      task.id,
      { reason: 'Provider outage has ended.' },
      database,
    );
    expect(queued).toMatchObject({ id: task.id, status: 'queued' });
    expect(
      (await database.select().from(tasks).where(eq(tasks.id, task.id)))[0],
    ).toMatchObject({ status: 'queued', error: null });
    const [event] = await database
      .select()
      .from(events)
      .where(
        and(
          eq(events.subjectId, task.id),
          eq(events.type, 'admin.task.retry_requested'),
        ),
      );
    expect(event).toMatchObject({
      userId: ownerId,
      actorId: adminId,
      visibility: 'internal',
    });
    expect(event.data).toMatchObject({
      reason: 'Provider outage has ended.',
      kind: 'contacts_search',
    });
    expect(
      (await listFailedAdminTasks(database)).some(
        (item) => item.id === task.id,
      ),
    ).toBe(false);
  });

  it('rejects publishing retries and requires a useful reason', async () => {
    const adminId = await user('admin');
    const ownerId = await user('candidate');
    const task = await failedTask(ownerId, 'publish_post');
    await expect(
      retryFailedAdminTask(
        adminId,
        task.id,
        { reason: 'retry please' },
        database,
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_TASK_RETRY' });
    await expect(
      retryFailedAdminTask(adminId, task.id, { reason: 'no' }, database),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      (await database.select().from(tasks).where(eq(tasks.id, task.id)))[0]
        .status,
    ).toBe('failed');
  });

  it('returns a queued task to failed if workflow dispatch fails and records the event', async () => {
    const adminId = await user('admin');
    const ownerId = await user('candidate');
    const task = await failedTask(ownerId, 'noop');
    await retryFailedAdminTask(
      adminId,
      task.id,
      { reason: 'Retry the test task.' },
      database,
    );
    await failAdminTaskDispatch(adminId, task.id, database);
    expect(
      (await database.select().from(tasks).where(eq(tasks.id, task.id)))[0],
    ).toMatchObject({ status: 'failed', error: 'RETRY_DISPATCH_FAILED' });
    const [event] = await database
      .select()
      .from(events)
      .where(
        and(
          eq(events.subjectId, task.id),
          eq(events.type, 'admin.task.retry_dispatch_failed'),
        ),
      );
    expect(event).toMatchObject({ actorId: adminId, visibility: 'internal' });
  });
  it('allows a requested deletion cleanup to retry but cannot start an unrequested deletion', async () => {
    const adminId = await user('admin'); const ownerId = await user('candidate');
    const task = await failedTask(ownerId, 'account_delete');
    await expect(retryFailedAdminTask(adminId, task.id, { reason: 'Retry account cleanup.' }, database)).rejects.toMatchObject({ code: 'DELETION_NOT_REQUESTED' });
    await database.update(users).set({ deletionRequestedAt: new Date() }).where(eq(users.id, ownerId));
    expect((await retryFailedAdminTask(adminId, task.id, { reason: 'Retry account cleanup.' }, database)).status).toBe('queued');
  });

});
