import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, events, users } from '@career-workspace/db';
import { createJob } from './roles';
import { reuseTailoredResume, restoreResume, saveResumeVersion } from './resumes';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('CV copy provenance and retries', () => {
  const { database, pool } = createDatabase(url!);
  let userId: string;
  beforeAll(async () => {
    if (new URL(url!).pathname !== '/career_workspace_test') throw new Error('Use career_workspace_test only.');
    const [user] = await database.insert(users).values({ clerkId: `reuse-provenance-${randomUUID()}` }).returning();
    userId = user.id;
  });
  afterAll(async () => {
    if (userId) await database.delete(users).where(eq(users.id, userId));
    await pool.end();
  });
  it('records a cross-role copy once as reuse, keeps real restores separate, and rejects copying to its own role', async () => {
    const role = async (title: string) => (await createJob(userId, {
      title, company: 'Provenance test', text: `${title}: Build accessible products with a team, write tests, maintain services and support customers. `.repeat(3),
    }, { database })).opportunity.id;
    const sourceRole = await role('Source role');
    const targetRole = await role('Target role');
    const source = await saveResumeVersion(userId, sourceRole, { name: 'Sam', contact: 'sam@example.test', sections: [{ title: 'Experience', bullets: [{ text: 'Worked on a student project.', fact_ids: [] }] }] }, { database });
    const copy = await reuseTailoredResume(userId, targetRole, source.id, { database, requestKey: 'intended-copy' });
    expect(copy).toMatchObject({ reusedFromId: source.id, restoredFromId: null, approvedAt: null });
    expect((await reuseTailoredResume(userId, targetRole, source.id, { database, requestKey: 'intended-copy' })).id).toBe(copy.id);
    const restored = await restoreResume(userId, source.id, database);
    expect(restored).toMatchObject({ restoredFromId: source.id, reusedFromId: null });
    await expect(reuseTailoredResume(userId, targetRole, restored.id, { database, requestKey: 'intended-copy' })).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
    await expect(reuseTailoredResume(userId, sourceRole, source.id, { database, requestKey: 'same-role' })).rejects.toMatchObject({ code: 'RESUME_ALREADY_FOR_ROLE' });
    const rows = await database.select().from(events).where(eq(events.userId, userId));
    expect(rows.filter(row => row.type === 'resume.reused')).toHaveLength(1);
    expect(rows.find(row => row.type === 'resume.reused')?.data).toMatchObject({ resumeId: copy.id, reusedFromId: source.id });
    expect(rows.filter(row => row.type === 'resume.restored')).toHaveLength(1);
  });
});
