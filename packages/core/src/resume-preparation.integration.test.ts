import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import {
  createDatabase,
  profileFacts,
  resumeVersions,
  users,
  type Database,
} from '@career-workspace/db';
import type { ResumeContent } from '@career-workspace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance } from './credits';
import { coachReaders } from './coach';
import { createJob } from './roles';
import { getResumePreparation } from './resume-preparation-service';
import { createTailoredResume, reuseTailoredResume, saveResumeVersion } from './resumes';
import { updateProfileFact } from './profile';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('resume preparation before generation', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userAId: string;
  let userBId: string;
  let typescriptFactId: string;
  let reactFactId: string;
  let otherFactId: string;
  let foreignResumeId: string;
  let roleAId: string;
  let roleBId: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
    const rows = await database.insert(users).values([
      { clerkId: `resume-preparation-a-${randomUUID()}` },
      { clerkId: `resume-preparation-b-${randomUUID()}` },
    ]).returning({ id: users.id });
    [userAId, userBId] = rows.map(({ id }) => id);

    const facts = await database.insert(profileFacts).values([
      {
        userId: userAId,
        kind: 'experience',
        text: 'Built TypeScript web APIs and collaborated with product designers.',
        source: 'user',
        status: 'approved',
      },
      {
        userId: userAId,
        kind: 'project',
        text: 'Created a React photo gallery for a student society.',
        source: 'user',
        status: 'approved',
      },
      {
        userId: userBId,
        kind: 'experience',
        text: 'Built an unrelated Go service for another candidate.',
        source: 'user',
        status: 'approved',
      },
    ]).returning({ id: profileFacts.id });
    [typescriptFactId, reactFactId, otherFactId] = facts.map(({ id }) => id);

    const role = await createJob(userAId, {
      title: 'Software Engineer',
      company: 'Preparation Test',
      text: 'We need a Software Engineer to build TypeScript web APIs and React interfaces. '.repeat(4),
    }, { database });
    roleAId = role.opportunity.id;
    const secondRole = await createJob(userAId, {
      title: 'Frontend Engineer',
      company: 'Reuse Test',
      text: 'Build accessible React interfaces with TypeScript. '.repeat(8),
    }, { database });
    roleBId = secondRole.opportunity.id;

    const foreignRole = await createJob(userBId, {
      title: 'Go Engineer',
      company: 'Other candidate',
      text: 'Build Go services. '.repeat(8),
    }, { database });
    const foreignResume = await saveResumeVersion(userBId, foreignRole.opportunity.id, {
      name: '',
      contact: '',
      sections: [{ title: 'Experience', bullets: [{ text: 'Built an unrelated Go service for another candidate.', fact_ids: [otherFactId] }] }],
    }, { database });
    foreignResumeId = foreignResume.id;
  });

  afterAll(async () => {
    if (userAId) await database.delete(users).where(eq(users.id, userAId));
    if (userBId) await database.delete(users).where(eq(users.id, userBId));
    await pool?.end();
  });

  it('requires a current confirmation, supplies role-specific evidence to the prompt, and reuses a draft for free', async () => {
    const initial = await getResumePreparation(userAId, roleAId, database);
    expect(initial.requirements.every(row => row.status === 'unknown' && row.fact_ids.length === 0)).toBe(true);
    expect(initial.skills.buckets.supportedByResume.map((row) => row.skill)).toContain('typescript');
    expect(initial.reuse.map((row) => row.resumeId)).not.toContain(foreignResumeId);
    const coachRole = await coachReaders(userAId, database).role(roleAId);
    expect(coachRole.resumeAts).toBeNull();
    expect(coachRole.resumePreparation?.reuse.map((row) => row.resumeId)).not.toContain(foreignResumeId);
    expect(coachRole.resumeSummary).toContain('Prepare or reuse your CV');

    const before = await balance(userAId, { database });
    await expect(createTailoredResume(userAId, roleAId, 'without-confirmation', {
      database,
      generate: createRecordedResponseGenerator({}),
    })).rejects.toMatchObject({ status: 409, code: 'RESUME_PREPARATION_REQUIRED' });
    expect((await balance(userAId, { database })).available).toBe(before.available);

    await updateProfileFact(userAId, typescriptFactId, {
      text: 'Built JavaScript web APIs and collaborated with product designers.',
    }, database);
    await expect(createTailoredResume(userAId, roleAId, 'stale-preparation', {
      database,
      confirmedSkills: true,
      preparationToken: initial.token,
      generate: createRecordedResponseGenerator({}),
    })).rejects.toMatchObject({ status: 409, code: 'RESUME_PREPARATION_REQUIRED' });
    expect((await balance(userAId, { database })).available).toBe(before.available);

    await updateProfileFact(userAId, typescriptFactId, {
      text: 'Built TypeScript web APIs and collaborated with product designers.',
    }, database);
    await updateProfileFact(userAId, typescriptFactId, { status: 'approved' }, database);
    const current = await getResumePreparation(userAId, roleAId, database);
    let promptInput: unknown;
    const recorded = createRecordedResponseGenerator({
      'tailor-cv.v6': {
        name: '',
        contact: '',
        sections: [
          {
            title: 'Projects',
            bullets: [{ text: 'Created a React photo gallery for a student society.', fact_ids: [reactFactId] }],
            entries: [],
          },
          {
            title: 'Experience',
            bullets: [{ text: 'Built TypeScript web APIs and collaborated with product designers.', fact_ids: [typescriptFactId] }],
            entries: [],
          },
        ],
        notes_for_candidate: [],
        left_out: [],
      },
    });
    const generate: typeof recorded = async (prompt, schema, input) => {
      promptInput = input;
      return recorded(prompt, schema, input);
    };
    const generated = await createTailoredResume(userAId, roleAId, 'confirmed-preparation', {
      database,
      confirmedSkills: true,
      preparationToken: current.token,
      generate,
    });
    expect(generated.promptVersion).toBe('tailor-cv.v6');
    expect(promptInput).toMatchObject({
      jobText: expect.stringContaining('TypeScript web APIs'),
      supportedSkills: expect.arrayContaining(['typescript']),
    });
    expect(promptInput).not.toHaveProperty('preparation');
    expect(generated.content.sections.map((section) => section.title)).toEqual(['Experience', 'Projects']);
    expect(generated.content.sections[0]?.bullets[0]?.fact_ids).toEqual([typescriptFactId]);
    const refreshed = await getResumePreparation(userAId, roleAId, database);
    expect(refreshed.reuse.map((row) => row.opportunityId)).not.toContain(roleAId);

    const sourceContent: ResumeContent = generated.content;
    const copied = await reuseTailoredResume(userAId, roleBId, generated.id, { requestKey: 'prepare-copy', database });
    expect(copied.content).toEqual(sourceContent);
    expect(copied).toMatchObject({ restoredFromId: null, reusedFromId: generated.id, approvedAt: null });
    expect((await balance(userAId, { database })).available).toBe(before.available - 3);

    await expect(reuseTailoredResume(userAId, roleBId, foreignResumeId, { requestKey: 'foreign-copy', database }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(coachReaders(userBId, database).role(roleAId))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(getResumePreparation(userBId, roleAId, database))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect((await database.select().from(resumeVersions).where(eq(resumeVersions.userId, userAId))).length).toBe(2);
  });
});
