import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applicationHandoffs,
  createDatabase,
  resumeVersions,
  users,
} from '@career-workspace/db';
import { createJob } from './roles';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('application handoff database constraints', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkIdA = `handoff-constraint-a-${randomUUID()}`;
  const clerkIdB = `handoff-constraint-b-${randomUUID()}`;
  let userAId: string;
  let userBId: string;
  let opportunityAId: string;
  let opportunityBId: string;
  let resumeBId: string;

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const rows = await database
      .insert(users)
      .values([{ clerkId: clerkIdA }, { clerkId: clerkIdB }])
      .returning({ id: users.id });
    [userAId, userBId] = rows.map((row) => row.id);
    const [roleA, roleB] = await Promise.all([
      createJob(
        userAId,
        {
          title: 'Analyst role A',
          company: 'Example A',
          url: `https://jobs.example.test/${randomUUID()}`,
          text: 'Research, writing, data analysis, and client presentations. '.repeat(
            3,
          ),
        },
        { database },
      ),
      createJob(
        userBId,
        {
          title: 'Analyst role B',
          company: 'Example B',
          url: `https://jobs.example.test/${randomUUID()}`,
          text: 'Research, writing, data analysis, and client presentations. '.repeat(
            3,
          ),
        },
        { database },
      ),
    ]);
    opportunityAId = roleA.opportunity.id;
    opportunityBId = roleB.opportunity.id;
    const [resume] = await database
      .insert(resumeVersions)
      .values({
        userId: userBId,
        opportunityId: opportunityBId,
        version: 1,
        content: { name: '', contact: '', sections: [] },
      })
      .returning({ id: resumeVersions.id });
    resumeBId = resume.id;
  });

  afterAll(async () => {
    await database.delete(users).where(eq(users.clerkId, clerkIdA));
    await database.delete(users).where(eq(users.clerkId, clerkIdB));
    await pool.end();
  });

  const insertHandoff = (
    values: Partial<typeof applicationHandoffs.$inferInsert> = {},
  ) =>
    database.insert(applicationHandoffs).values({
      userId: userAId,
      opportunityId: opportunityAId,
      source: 'employer_link',
      ...values,
    });

  it('rejects unsupported source and response values', async () => {
    await expect(insertHandoff({ source: 'upload' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(
      insertHandoff({ response: 'maybe', answeredAt: new Date() }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('requires answeredAt to be present exactly when a response is present', async () => {
    await expect(insertHandoff({ response: 'applied' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(
      insertHandoff({ answeredAt: new Date() }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects an opportunity owned by another user', async () => {
    await expect(
      insertHandoff({ opportunityId: opportunityBId }),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('rejects a resume whose owner and opportunity do not match the handoff', async () => {
    await expect(insertHandoff({ resumeId: resumeBId })).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });

  it('accepts an unanswered handoff with a supported source and no resume', async () => {
    const [saved] = await insertHandoff({ source: 'approved_pdf' }).returning();
    expect(saved.userId).toBe(userAId);
    expect(saved.opportunityId).toBe(opportunityAId);
    expect(saved.response).toBeNull();
    expect(saved.answeredAt).toBeNull();
  });
});
