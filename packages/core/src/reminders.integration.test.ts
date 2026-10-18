import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, reminders, users } from '@career-workspace/db';
import { createJob } from './roles';
import { listPendingReminders } from './reminders';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('private reminder reader', () => {
  const { database, pool } = createDatabase(url!);
  const ids: string[] = [];
  afterAll(async () => {
    for (const id of ids) await database.delete(users).where(eq(users.id, id));
    await pool.end();
  });
  it('reads only this candidate’s pending reminders', async () => {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const candidates = await database
      .insert(users)
      .values([
        { clerkId: `reminder-a-${randomUUID()}` },
        { clerkId: `reminder-b-${randomUUID()}` },
      ])
      .returning();
    ids.push(...candidates.map((user) => user.id));
    const role = await createJob(
      candidates[0].id,
      {
        title: 'Sample role',
        company: 'Sample employer',
        text: 'This graduate role involves building accessible web tools, working with a small engineering team, testing software carefully and communicating clearly with customers.',
      },
      { database },
    );
    await database.insert(reminders).values([
      {
        userId: candidates[0].id,
        opportunityId: role.opportunity.id,
        title: 'Own follow-up',
        dueAt: new Date(),
      },
      {
        userId: candidates[0].id,
        opportunityId: role.opportunity.id,
        title: 'Stopped follow-up',
        dueAt: new Date(),
        status: 'stopped',
      },
      {
        userId: candidates[1].id,
        opportunityId: role.opportunity.id,
        title: 'Other candidate private note',
        dueAt: new Date(),
      },
    ]);
    const own = await listPendingReminders(candidates[0].id, database);
    expect(own.map((reminder) => reminder.title)).toEqual(['Own follow-up']);
  });
});
