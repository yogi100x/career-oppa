import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  jobs,
  opportunities,
  users,
} from '@career-workspace/db';
import { and, eq } from 'drizzle-orm';
import {
  canonicalJobUrl,
  createJob,
  getOpportunity,
  listOpportunities,
} from './roles';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('private role ingestion', () => {
  const { database, pool } = createDatabase(url!);
  const ids: string[] = [];
  const input = {
    title: 'Graduate developer',
    company: 'Sample company',
    url: 'https://example.com/roles/graduate',
    text: 'We are seeking a graduate developer to build accessible web applications with TypeScript and collaborate with our team. Relevant projects and communication skills are valued.',
  };
  async function candidate() {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const [user] = await database
      .insert(users)
      .values({ clerkId: `roles-${randomUUID()}` })
      .returning();
    ids.push(user.id);
    return user.id;
  }
  afterAll(async () => {
    for (const id of ids) await database.delete(users).where(eq(users.id, id));
    await pool.end();
  });
  it('canonicalises tracking parameters and keeps meaningful parameters', () => {
    expect(
      canonicalJobUrl('https://example.com/role/?utm_source=x&b=2&a=1#apply'),
    ).toBe('https://example.com/role?a=1&b=2');
  });
  it('creates job and opportunity once under a same-link race', async () => {
    const user = await candidate();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createJob(user, input, { database })),
    );
    expect(new Set(results.map((result) => result.opportunity.id)).size).toBe(
      1,
    );
    expect(
      await database.select().from(jobs).where(eq(jobs.userId, user)),
    ).toHaveLength(1);
    expect(
      await database
        .select()
        .from(opportunities)
        .where(eq(opportunities.userId, user)),
    ).toHaveLength(1);
  });
  it('deduplicates the same pasted description, including whitespace changes', async () => {
    const user = await candidate();
    const pasted = { ...input, url: undefined };
    const first = await createJob(user, pasted, { database });
    const second = await createJob(
      user,
      { ...pasted, text: `  ${input.text.replace(' with ', '  with\n')}  ` },
      { database },
    );
    expect(second.opportunity.id).toBe(first.opportunity.id);
    expect(await database.select().from(jobs).where(eq(jobs.userId, user))).toHaveLength(1);
    expect(await database.select().from(opportunities).where(eq(opportunities.userId, user))).toHaveLength(1);
  });
  it('keeps the same URL and private pasted text separate for two users', async () => {
    const first = await candidate();
    const second = await candidate();
    const a = await createJob(first, input, { database });
    const b = await createJob(
      second,
      { ...input, text: `${input.text} Private second-user notes.` },
      { database },
    );
    expect(a.job.id).not.toBe(b.job.id);
    expect(
      (await listOpportunities(first, database))[0].job.text,
    ).not.toContain('Private second-user');
    await expect(
      getOpportunity(second, a.opportunity.id, database),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rolls back a failed opportunity insertion with its job', async () => {
    const user = await candidate();
    // A failure injected after the first insert exercises the actual transaction rollback.
    await expect(
      database.transaction(async (tx) => {
        await tx
          .insert(jobs)
          .values({
            userId: user,
            source: 'paste',
            title: 'Rollback',
            company: 'Sample',
            text: input.text,
            textHash: 'rollback',
          });
        await tx
          .insert(opportunities)
          .values({ userId: user, jobId: randomUUID() });
      }),
    ).rejects.toThrow();
    expect(
      await database
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, user), eq(jobs.textHash, 'rollback'))),
    ).toHaveLength(0);
  });
});
