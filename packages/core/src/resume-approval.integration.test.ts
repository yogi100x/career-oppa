import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  createDatabase,
  profileFacts,
  resumeVersions,
  users,
} from '@career-workspace/db';
import type { PrivateStorage } from '@career-workspace/adapters/storage';
import { createJob } from './roles';
import { createTailoredResume, saveResumeVersion } from './resumes';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import { approveResume } from './resume-approval';
import { getResumePreparation } from './resume-preparation-service';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('resume PDF approval', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkIdA = `resume-approval-a-${randomUUID()}`;
  const clerkIdB = `resume-approval-b-${randomUUID()}`;
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

  async function approvedFact(text: string) {
    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId: userAId,
        kind: 'experience',
        text,
        source: 'user',
        status: 'approved',
      })
      .returning();
    return fact;
  }

  async function resumeFor(factId: string) {
    const { opportunity } = await createJob(
      userAId,
      {
        title: 'Software engineer',
        company: 'Sample company',
        text: 'Build software and work with a supportive product team. '.repeat(
          4,
        ),
      },
      { database },
    );
    return saveResumeVersion(
      userAId,
      opportunity.id,
      {
        name: 'Alex Morgan',
        contact: 'alex@example.test',
        sections: [
          {
            title: 'Experience',
            bullets: [
              {
                text: 'Built an internal tool for a product team.',
                fact_ids: [factId],
              },
            ],
          },
        ],
      },
      { database },
    );
  }

  function testStorage() {
    const stored = new Map<string, Uint8Array>();
    let putCount = 0;
    const storage: PrivateStorage = {
      async put(key, contents) {
        putCount += 1;
        stored.set(key, new Uint8Array(contents));
      },
      async get(key) {
        const contents = stored.get(key);
        return contents ? new Uint8Array(contents) : null;
      },
      async delete(key) {
        stored.delete(key);
      },
    };
    return {
      storage,
      stored,
      get putCount() {
        return putCount;
      },
    };
  }

  it('stores one private PDF per approved version and makes retries idempotent', async () => {
    const fact = await approvedFact(
      'Built an internal tool for a product team.',
    );
    const resume = await resumeFor(fact.id);
    const files = testStorage();
    const render = async () => new TextEncoder().encode('%PDF-1.7 test PDF');

    const approved = await approveResume(
      userAId,
      resume.id,
      { confirmedFactPairs: true, confirmedHeader: true, pageSize: 'A4' },
      { database, storage: files.storage, render },
    );
    expect(approved).toMatchObject({
      approvedAt: expect.any(Date),
      pageSize: 'A4',
    });
    expect(approved.pdfFileId).toBeTruthy();
    expect(files.stored.size).toBe(1);
    expect(files.putCount).toBe(1);
    // The confirmed header is saved once and prefilled into the next draft.
    const [saved] = await database
      .select({ cvName: users.cvName, cvContact: users.cvContact })
      .from(users)
      .where(eq(users.id, userAId));
    expect(saved).toEqual({
      cvName: 'Alex Morgan',
      cvContact: 'alex@example.test',
    });
    const preparation = await getResumePreparation(userAId, resume.opportunityId, database);
    const nextDraft = await createTailoredResume(
      userAId,
      resume.opportunityId,
      'prefill-check',
      {
        database,
        confirmedSkills: true,
        preparationToken: preparation.token,
        generate: createRecordedResponseGenerator({
          'tailor-cv.v6': {
            name: 'Model Invented',
            contact: 'invented@example.test',
            sections: [
              {
                title: 'Experience',
                bullets: [
                  {
                    text: 'Built an internal tool for a product team.',
                    fact_ids: [fact.id],
                  },
                ],
                entries: [],
              },
            ],
            notes_for_candidate: [],
            left_out: [],
          },
        }),
      },
    );
    expect(nextDraft.content.name).toBe('Alex Morgan');
    expect(nextDraft.content.contact).toBe('alex@example.test');
    expect(nextDraft.approvedAt).toBeNull();

    const retry = await approveResume(
      userAId,
      resume.id,
      { confirmedFactPairs: true, confirmedHeader: true, pageSize: 'LETTER' },
      { database, storage: files.storage, render },
    );
    expect(retry.pdfFileId).toBe(approved.pdfFileId);
    expect(retry.pageSize).toBe('A4');
    expect(files.stored.size).toBe(1);
    expect(files.putCount).toBe(1);

    await database
      .update(profileFacts)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(profileFacts.id, fact.id));
    await expect(
      approveResume(
        userAId,
        resume.id,
        { confirmedFactPairs: true, confirmedHeader: true, pageSize: 'A4' },
        { database, storage: files.storage, render },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'RESUME_NOT_GROUNDED' });
    expect(files.stored.size).toBe(1);
    expect(files.putCount).toBe(1);

    await expect(
      approveResume(
        userBId,
        resume.id,
        { confirmedFactPairs: true, confirmedHeader: true, pageSize: 'A4' },
        { database, storage: files.storage, render },
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const [persisted] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, resume.id));
    expect(persisted.pdfFileId).toBe(approved.pdfFileId);
  });

  it('blocks approval when a cited fact is no longer approved', async () => {
    const fact = await approvedFact('Mentored new teammates.');
    const resume = await resumeFor(fact.id);
    await database
      .update(profileFacts)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(profileFacts.id, fact.id));
    const files = testStorage();

    await expect(
      approveResume(
        userAId,
        resume.id,
        { confirmedFactPairs: true, confirmedHeader: true, pageSize: 'A4' },
        {
          database,
          storage: files.storage,
          render: async () => new TextEncoder().encode('%PDF-1.7 test PDF'),
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'RESUME_NOT_GROUNDED' });
    expect(files.stored.size).toBe(0);
    const [persisted] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, resume.id));
    expect(persisted).toMatchObject({ approvedAt: null, pdfFileId: null });
  });
  it('refuses to write a private PDF after account deletion is requested', async () => {
    const fact = await approvedFact('Built a private document tool.');
    const resume = await resumeFor(fact.id);
    const files = testStorage();
    await database
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, userAId));
    try {
      await expect(
        approveResume(
          userAId,
          resume.id,
          { confirmedFactPairs: true, confirmedHeader: true, pageSize: 'A4' },
          {
            database,
            storage: files.storage,
            render: async () => new TextEncoder().encode('%PDF-1.7 test PDF'),
          },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'ACCOUNT_DELETION_PENDING',
      });
      expect(files.putCount).toBe(0);
    } finally {
      await database
        .update(users)
        .set({ deletionRequestedAt: null })
        .where(eq(users.id, userAId));
    }
  });
});
