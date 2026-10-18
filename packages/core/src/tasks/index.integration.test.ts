import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, users } from '@career-workspace/db';
import { eq } from 'drizzle-orm';
import {
  createTask,
  failTask,
  getTask,
  runNoOp,
  startTask,
  succeedTask,
} from './index';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('recorded task lifecycle', () => {
  const { database, pool } = createDatabase(url!);
  const ids: string[] = [];
  async function candidate() {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const [user] = await database
      .insert(users)
      .values({ clerkId: `tasks-${randomUUID()}` })
      .returning();
    ids.push(user.id);
    return user.id;
  }
  afterAll(async () => {
    for (const id of ids) await database.delete(users).where(eq(users.id, id));
    await pool.end();
  });
  it('records queued, running and succeeded separately and replays a completed no-op', async () => {
    const user = await candidate();
    const task = await createTask(user, 'noop', 'states', {}, database);
    expect(task.status).toBe('queued');
    expect((await startTask(user, task.id, database)).status).toBe('running');
    expect(
      (await succeedTask(user, task.id, { noop: true }, database)).status,
    ).toBe('succeeded');
    const first = await runNoOp(user, 'run', database);
    expect((await runNoOp(user, 'run', database)).id).toBe(first.id);
    expect(first.attempts).toBe(1);
  });
  it('records failure, permits retry, and cannot overwrite a finished task', async () => {
    const user = await candidate();
    const task = await createTask(user, 'noop', 'failure', {}, database);
    await startTask(user, task.id, database);
    expect(
      (await failTask(user, task.id, 'PROVIDER_FAILED', database)).status,
    ).toBe('failed');
    expect((await startTask(user, task.id, database)).attempts).toBe(2);
    await succeedTask(user, task.id, {}, database);
    await expect(
      failTask(user, task.id, 'FAILED', database),
    ).rejects.toMatchObject({ code: 'TASK_NOT_RUNNING' });
  });
  it('another user cannot read or change a task', async () => {
    const first = await candidate();
    const second = await candidate();
    const task = await createTask(first, 'noop', 'private', {}, database);
    await expect(getTask(second, task.id, database)).rejects.toMatchObject({
      status: 404,
    });
    await expect(startTask(second, task.id, database)).rejects.toMatchObject({
      status: 404,
    });
  });
});
