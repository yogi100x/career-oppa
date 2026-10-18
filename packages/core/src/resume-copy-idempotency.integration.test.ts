import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createDatabase,
  profileFacts,
  resumeVersions,
  users,
  type Database,
} from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJob } from './roles';
import { getCompletedResumeReuse, reuseTailoredResume, saveResumeVersion } from './resumes';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('saved CV copy request keys', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  let opportunityId: string;
  let factId: string;
  let firstSourceId: string;
  let secondSourceId: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
    const [user] = await database.insert(users).values({
      clerkId: `resume-copy-key-${randomUUID()}`,
    }).returning({ id: users.id });
    userId = user.id;
    const [fact] = await database.insert(profileFacts).values({
      userId,
      kind: 'experience',
      text: 'Built reliable TypeScript software.',
      source: 'user',
      status: 'approved',
    }).returning({ id: profileFacts.id });
    factId = fact.id;
    const role = await createJob(userId, {
      title: 'Software Engineer',
      company: 'Copy key test',
      text: 'Build reliable TypeScript software for customers. '.repeat(8),
    }, { database });
    const target = await createJob(userId, {
      title: 'Target Software Engineer',
      company: 'Copy target',
      text: 'Maintain accessible TypeScript products, review code and support customer teams. '.repeat(5),
    }, { database });
    opportunityId = target.opportunity.id;
    const content = {
      name: '',
      contact: '',
      sections: [{
        title: 'Experience',
        bullets: [{ text: 'Built reliable TypeScript software.', fact_ids: [factId] }],
        entries: [],
      }],
    };
    const first = await saveResumeVersion(userId, role.opportunity.id, content, { database });
    const second = await saveResumeVersion(userId, role.opportunity.id, content, { database });
    firstSourceId = first.id;
    secondSourceId = second.id;
  });

  afterAll(async () => {
    if (userId) await database.delete(users).where(eq(users.id, userId));
    await pool?.end();
  });

  it('replays the same copy for a key and rejects a different source', async () => {
    const first = await reuseTailoredResume(userId, opportunityId, firstSourceId, {
      requestKey: 'same-copy-key', database,
    });
    const replay = await reuseTailoredResume(userId, opportunityId, firstSourceId, {
      requestKey: 'same-copy-key', database,
    });
    expect(replay.id).toBe(first.id);
    expect(replay.version).toBe(first.version);
    await expect(getCompletedResumeReuse(userId, opportunityId, firstSourceId, 'same-copy-key', database)).resolves.toMatchObject({ id: first.id });
    await expect(getCompletedResumeReuse(userId, opportunityId, secondSourceId, 'same-copy-key', database)).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
    await expect(getCompletedResumeReuse(randomUUID(), opportunityId, firstSourceId, 'same-copy-key', database)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getCompletedResumeReuse(userId, opportunityId, firstSourceId, 'unused-key', database)).resolves.toBeNull();

    await expect(reuseTailoredResume(userId, opportunityId, secondSourceId, {
      requestKey: 'same-copy-key', database,
    })).rejects.toMatchObject({ status: 409, code: 'REQUEST_KEY_CONFLICT' });

    const copies = await database.select({ id: resumeVersions.id }).from(resumeVersions)
      .where(eq(resumeVersions.requestKey, 'same-copy-key'));
    expect(copies).toHaveLength(1);
  });

  it('serialises concurrent copies for the same request and rejects empty keys', async () => {
    const copies = await Promise.all([1, 2].map(() => reuseTailoredResume(userId, opportunityId, firstSourceId, {
      requestKey: 'concurrent-copy-key', database,
    })));
    expect(copies[0].id).toBe(copies[1].id);
    await expect(reuseTailoredResume(userId, opportunityId, firstSourceId, {
      requestKey: '', database,
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
  });

  it('creates a new copy for a new key', async () => {
    const copied = await reuseTailoredResume(userId, opportunityId, firstSourceId, {
      requestKey: 'another-copy-key', database,
    });
    expect(copied.id).not.toBe(firstSourceId);
    expect(copied.version).toBeGreaterThan(2);

    const secondCopy = await reuseTailoredResume(
      userId, opportunityId, secondSourceId, { requestKey: 'third-copy-key', database },
    );
    expect(secondCopy.reusedFromId).toBe(secondSourceId);
    expect(secondCopy.restoredFromId).toBeNull();
  });
});
