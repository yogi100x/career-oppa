import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PrivateStorage } from '@career-workspace/adapters/storage';
import type { ResumeContent } from '@career-workspace/contracts';
import {
  createDatabase,
  answerDrafts,
  opportunities,
  profileFacts,
  resumeVersions,
  users,
  type Database,
} from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveResume } from './resume-approval';
import {
  answerApplicationHandoff,
  createApplicationHandoff,
  listPendingApplicationHandoffs,
} from './application-handoff';
import { getOwnedUserFile } from './files';
import { updateOpportunityStatus } from './opportunity-status';
import {
  createProject,
  deleteProject as deleteProjectCore,
  updateProfileFact as updateProfileFactCore,
} from './profile';
import { createJob } from './roles';
import { saveResumeVersion } from './resumes';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;
const pdf = new TextEncoder().encode('%PDF-1.7 regression fixture');

integration('resume validity after profile changes', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  const clerkId = `resume-validity-${randomUUID()}`;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
    const [user] = await database
      .insert(users)
      .values({ clerkId })
      .returning({ id: users.id });
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await database.delete(users).where(eq(users.id, userId));
    await pool?.end();
  });

  let activeStorage: PrivateStorage | undefined;
  const updateProfileFact = (
    ...args: Parameters<typeof updateProfileFactCore>
  ) =>
    updateProfileFactCore(args[0], args[1], args[2], args[3], {
      storage: activeStorage,
    });
  const deleteProject = (...args: Parameters<typeof deleteProjectCore>) =>
    deleteProjectCore(args[0], args[1], args[2], { storage: activeStorage });

  function privateStorage() {
    const objects = new Map<string, Uint8Array>();
    const storage: PrivateStorage = {
      async put(key, contents) {
        objects.set(key, new Uint8Array(contents));
      },
      async get(key) {
        const value = objects.get(key);
        return value ? new Uint8Array(value) : null;
      },
      async delete(key) {
        objects.delete(key);
      },
    };
    activeStorage = storage;
    return { storage, objects };
  }

  async function addApprovedFact(text: string) {
    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId,
        kind: 'experience',
        text,
        source: 'user',
        status: 'approved',
      })
      .returning();
    return fact;
  }

  async function addRole(title: string) {
    const { opportunity } = await createJob(
      userId,
      {
        title,
        company: `Company ${randomUUID()}`,
        url: `https://employer.example.test/jobs/${randomUUID()}`,
        text: `This role asks for clear collaboration, careful planning, and reliable delivery. ${randomUUID()} `.repeat(
          3,
        ),
      },
      { database },
    );
    return opportunity.id;
  }

  async function addResume(
    opportunityId: string,
    factIds: string[],
    header: { name: string; contact: string } = {
      name: 'Alex Morgan',
      contact: 'alex@example.test',
    },
  ) {
    const content: ResumeContent = {
      ...header,
      sections: [
        {
          title: 'Experience',
          bullets: factIds.map((factId) => ({
            text: 'Supported by an approved fact.',
            fact_ids: [factId],
          })),
        },
      ],
    };
    return saveResumeVersion(userId, opportunityId, content, { database });
  }

  async function approve(
    resumeId: string,
    files: ReturnType<typeof privateStorage>,
  ) {
    return approveResume(
      userId,
      resumeId,
      { confirmedFactPairs: true, confirmedHeader: true, pageSize: 'A4' },
      { database, storage: files.storage, render: async () => pdf },
    );
  }

  it.each(['rejected', 'proposed', 'edited'] as const)(
    'revokes cited answer approval on %s without restoring it on fact reapproval',
    async (change) => {
      const cited = await addApprovedFact('Designed a research project.');
      const other = await addApprovedFact('Planned a community event.');
      const opportunityId = await addRole('Answer revocation');
      const answers = await database
        .insert(answerDrafts)
        .values(
          [cited, other].map((fact) => ({
            userId,
            opportunityId,
            question: 'Describe your experience',
            answer: fact.text,
            factIds: [fact.id],
            approvedAt: new Date(),
            promptVersion: 'fixture',
            model: 'fixture',
          })),
        )
        .returning();
      await updateProfileFact(
        userId,
        cited.id,
        change === 'edited'
          ? { text: 'A corrected description.' }
          : { status: change },
        database,
      );
      const rows = await database
        .select()
        .from(answerDrafts)
        .where(eq(answerDrafts.opportunityId, opportunityId));
      expect(rows.find((a) => a.id === answers[0].id)?.approvedAt).toBeNull();
      expect(
        rows.find((a) => a.id === answers[1].id)?.approvedAt,
      ).toBeInstanceOf(Date);
      await updateProfileFact(
        userId,
        cited.id,
        { status: 'approved' },
        database,
      );
      const [after] = await database
        .select()
        .from(answerDrafts)
        .where(eq(answerDrafts.id, answers[0].id));
      expect(after.approvedAt).toBeNull();
    },
  );

  it('revokes only resumes citing the changed fact, removes their pending prompt, and does not restore approval when the fact is reapproved', async () => {
    const cited = await addApprovedFact('Designed a reliable planning system.');
    const untouched = await addApprovedFact(
      'Coordinated a student research group.',
    );
    const citedOpportunity = await addRole('Cited fact role');
    const untouchedOpportunity = await addRole('Unrelated fact role');
    await updateOpportunityStatus(
      userId,
      citedOpportunity,
      'reviewed',
      database,
    );
    const citedResume = await addResume(citedOpportunity, [cited.id]);
    const untouchedResume = await addResume(untouchedOpportunity, [
      untouched.id,
    ]);
    const storage = privateStorage();
    const approvedCited = await approve(citedResume.id, storage);
    const approvedUntouched = await approve(untouchedResume.id, storage);
    expect(approvedCited.pdfFileId).toBeTruthy();
    expect(approvedUntouched.pdfFileId).toBeTruthy();

    const handoff = await createApplicationHandoff(
      userId,
      { opportunityId: citedOpportunity, source: 'employer_link' },
      database,
    );
    expect(await listPendingApplicationHandoffs(userId, database)).toHaveLength(
      1,
    );
    await updateProfileFact(userId, cited.id, { status: 'rejected' }, database);

    const [revoked] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, citedResume.id));
    const [stillApproved] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, untouchedResume.id));
    expect(revoked).toMatchObject({ approvedAt: null, pdfFileId: null });
    expect(stillApproved.approvedAt).toBeInstanceOf(Date);
    expect(stillApproved.pdfFileId).toBe(approvedUntouched.pdfFileId);
    await expect(
      getOwnedUserFile(userId, approvedCited.pdfFileId!, {
        database,
        storage: storage.storage,
      }),
    ).resolves.toBeNull();
    expect(
      await getOwnedUserFile(userId, approvedUntouched.pdfFileId!, {
        database,
        storage: storage.storage,
      }),
    ).toMatchObject({ id: approvedUntouched.pdfFileId, contents: pdf });
    expect(await listPendingApplicationHandoffs(userId, database)).toEqual([]);
    await expect(
      answerApplicationHandoff(
        userId,
        handoff.outcome === 'skipped' ? '' : handoff.handoff.id,
        { answer: 'applied' },
        database,
      ),
    ).rejects.toMatchObject({ status: 404 });

    await updateProfileFact(userId, cited.id, { status: 'approved' }, database);
    const [afterReapproval] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, citedResume.id));
    expect(afterReapproval).toMatchObject({
      approvedAt: null,
      pdfFileId: null,
    });
    await expect(
      getOwnedUserFile(userId, approvedCited.pdfFileId!, {
        database,
        storage: storage.storage,
      }),
    ).resolves.toBeNull();
  });

  it('revokes an approval when a fact returns to proposed or its text changes', async () => {
    const fact = await addApprovedFact('Built a reliable planning tool.');
    const opportunityId = await addRole('Proposed fact role');
    const resume = await addResume(opportunityId, [fact.id]);
    const storage = privateStorage();
    const approved = await approve(resume.id, storage);

    const proposed = await updateProfileFact(
      userId,
      fact.id,
      { status: 'proposed' },
      database,
    );
    expect(proposed.status).toBe('proposed');
    const [proposedResume] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, resume.id));
    expect(proposedResume).toMatchObject({ approvedAt: null, pdfFileId: null });
    await expect(
      getOwnedUserFile(userId, approved.pdfFileId!, {
        database,
        storage: storage.storage,
      }),
    ).resolves.toBeNull();

    const editedFact = await addApprovedFact('Designed a useful data system.');
    const editedOpportunity = await addRole('Edited text role');
    const editedResume = await addResume(editedOpportunity, [editedFact.id]);
    const approvedEdited = await approve(editedResume.id, storage);
    const changed = await updateProfileFact(
      userId,
      editedFact.id,
      {
        text: 'Built a different tool with a different result.',
        status: 'approved',
      },
      database,
    );
    expect(changed.status).toBe('proposed');
    const [revoked] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, editedResume.id));
    expect(revoked).toMatchObject({ approvedAt: null, pdfFileId: null });
    await expect(
      getOwnedUserFile(userId, approvedEdited.pdfFileId!, {
        database,
        storage: storage.storage,
      }),
    ).resolves.toBeNull();
  });

  it('blocks stale direct database mutations from PDF download and application handoff', async () => {
    const fact = await addApprovedFact('Led a small research project.');
    const opportunityId = await addRole('Direct mutation role');
    const resume = await addResume(opportunityId, [fact.id]);
    const storage = privateStorage();
    const approved = await approve(resume.id, storage);
    await database
      .update(profileFacts)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(profileFacts.id, fact.id));

    await expect(
      getOwnedUserFile(userId, approved.pdfFileId!, {
        database,
        storage: storage.storage,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'RESUME_NOT_GROUNDED' });
    await expect(
      createApplicationHandoff(
        userId,
        { opportunityId, source: 'employer_link' },
        database,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'RESUME_NOT_GROUNDED' });
    expect(await listPendingApplicationHandoffs(userId, database)).toEqual([]);
  });

  it('requires a real name and contact before storing an approved PDF', async () => {
    const fact = await addApprovedFact('Created an accessible student portal.');
    const opportunityId = await addRole('Header validation role');
    const resume = await addResume(opportunityId, [fact.id], {
      name: '',
      contact: '',
    });
    const storage = privateStorage();

    await expect(approve(resume.id, storage)).rejects.toMatchObject({
      status: 409,
      code: 'RESUME_HEADER_REQUIRED',
    });
    expect(storage.objects.size).toBe(0);
    const [unchanged] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, resume.id));
    expect(unchanged).toMatchObject({ approvedAt: null, pdfFileId: null });
  });

  it('revokes a CV approval when its cited project claim is deleted', async () => {
    const project = await createProject(
      userId,
      {
        title: 'Community mentoring',
        summary: 'A local mentoring project.',
        links: [],
        claims: [
          { kind: 'achievement', text: 'Mentored five students each week.' },
        ],
      },
      database,
    );
    const [claim] = project.claims;
    await updateProfileFact(userId, claim.id, { status: 'approved' }, database);
    const opportunityId = await addRole('Deleted project claim role');
    const resume = await addResume(opportunityId, [claim.id]);
    const storage = privateStorage();
    const approved = await approve(resume.id, storage);
    expect(approved.pdfFileId).toBeTruthy();

    await deleteProject(userId, project.id, database);

    const [revoked] = await database
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, resume.id));
    expect(revoked).toMatchObject({ approvedAt: null, pdfFileId: null });
    await expect(
      getOwnedUserFile(userId, approved.pdfFileId!, {
        database,
        storage: storage.storage,
      }),
    ).resolves.toBeNull();
  });

  it.each(['saved', 'reviewed'] as const)(
    'allows a valid approved PDF to start the handoff from %s',
    async (initialStatus) => {
      const fact = await addApprovedFact(
        `Prepared a project for a ${initialStatus} role.`,
      );
      const opportunityId = await addRole(`Handoff from ${initialStatus}`);
      if (initialStatus === 'reviewed')
        await updateOpportunityStatus(
          userId,
          opportunityId,
          'reviewed',
          database,
        );
      const resume = await addResume(opportunityId, [fact.id]);
      await approve(resume.id, privateStorage());

      const handoff = await createApplicationHandoff(
        userId,
        { opportunityId, source: 'employer_link' },
        database,
      );
      const [role] = await database
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, opportunityId));
      expect(role.status).toBe('preparing');
      expect(
        (await listPendingApplicationHandoffs(userId, database)).map(
          ({ id }) => id,
        ),
      ).toContain(handoff.outcome === 'skipped' ? '' : handoff.handoff.id);
    },
  );
});
