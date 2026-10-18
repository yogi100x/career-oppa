import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase, users } from '@career-workspace/db';
import { createJob } from './roles';
import {
  getOpportunityTimeline,
  updateOpportunityStatus,
} from './opportunity-status';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('opportunity status and timeline', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkIdA = `opportunity-status-a-${randomUUID()}`;
  const clerkIdB = `opportunity-status-b-${randomUUID()}`;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const rows = await database
      .insert(users)
      .values([{ clerkId: clerkIdA }, { clerkId: clerkIdB }])
      .returning({ id: users.id });
    [userAId, userBId] = rows.map(({ id }) => id);
  });

  afterAll(async () => {
    await database
      .delete(users)
      .where(and(eq(users.clerkId, clerkIdA), eq(users.id, userAId)));
    await database
      .delete(users)
      .where(and(eq(users.clerkId, clerkIdB), eq(users.id, userBId)));
    await pool.end();
  });

  it('writes a timeline event only when the owner changes status', async () => {
    const { opportunity } = await createJob(
      userAId,
      {
        title: 'Graduate engineer',
        company: 'Sample company',
        text: 'A graduate engineer role with practical software work. '.repeat(4),
      },
      { database },
    );
    const reviewed = await updateOpportunityStatus(
      userAId,
      opportunity.id,
      'reviewed',
      database,
    );
    expect(reviewed).toMatchObject({
      status: 'reviewed',
      nextStep: 'Decide whether to prepare an application',
    });

    await updateOpportunityStatus(userAId, opportunity.id, 'reviewed', database);
    const applied = await updateOpportunityStatus(
      userAId,
      opportunity.id,
      'applied',
      database,
    );
    expect(applied.nextStep).toBe('Follow up on your application');

    const timeline = await getOpportunityTimeline(
      userAId,
      opportunity.id,
      database,
    );
    const changes = timeline.filter(
      (event) => event.type === 'opportunity.status_changed',
    );
    expect(changes).toHaveLength(2);
    expect(changes.map((event) => event.data)).toEqual([
      {
        from: 'saved',
        to: 'reviewed',
        nextStep: 'Decide whether to prepare an application',
      },
      {
        from: 'reviewed',
        to: 'applied',
        nextStep: 'Follow up on your application',
      },
    ]);
  });

  it('does not expose another user’s role or timeline', async () => {
    const { opportunity } = await createJob(
      userAId,
      {
        title: 'Private role',
        company: 'Private company',
        text: 'A role description kept private to its candidate. '.repeat(4),
      },
      { database },
    );
    await expect(
      updateOpportunityStatus(userBId, opportunity.id, 'applied', database),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(
      getOpportunityTimeline(userBId, opportunity.id, database),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
