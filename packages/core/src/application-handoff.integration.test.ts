import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  applicationHandoffs,
  createDatabase,
  events,
  files,
  opportunities,
  profileFacts,
  resumeVersions,
  users,
} from '@career-workspace/db';
import {
  answerApplicationHandoff,
  createApplicationHandoff,
  listPendingApplicationHandoffs,
} from './application-handoff';
import { createJob } from './roles';
import { updateOpportunityStatus } from './opportunity-status';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('application handoff return prompt', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkIdA = `handoff-a-${randomUUID()}`;
  const clerkIdB = `handoff-b-${randomUUID()}`;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const rows = await database
      .insert(users)
      .values([{ clerkId: clerkIdA }, { clerkId: clerkIdB }])
      .returning({ id: users.id });
    [userAId, userBId] = rows.map((row) => row.id);
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

  async function preparingRole() {
    const { opportunity } = await createJob(
      userAId,
      {
        title: 'Graduate analyst',
        company: 'Northstar',
        url: `https://jobs.example.test/graduate-analyst-${randomUUID()}`,
        text: 'This role supports a team of analysts through research, clear writing, careful data handling and presentations for clients. '.repeat(
          3,
        ),
      },
      { database },
    );
    await updateOpportunityStatus(
      userAId,
      opportunity.id,
      'preparing',
      database,
    );
    return opportunity.id;
  }

  async function approvedResume(opportunityId: string) {
    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId: userAId,
        kind: 'experience',
        text: 'Supported a team through research and clear writing.',
        source: 'user',
        status: 'approved',
      })
      .returning({ id: profileFacts.id });
    const [file] = await database
      .insert(files)
      .values({
        userId: userAId,
        r2Key: `handoff-test/${randomUUID()}.pdf`,
        kind: 'resume_pdf',
        originalName: 'approved-resume.pdf',
        contentType: 'application/pdf',
        size: 128,
      })
      .returning({ id: files.id });
    const [resume] = await database
      .insert(resumeVersions)
      .values({
        userId: userAId,
        opportunityId,
        version: 1,
        approvedAt: new Date(),
        pdfFileId: file.id,
        content: {
          name: 'Alex Morgan',
          contact: 'alex@example.test',
          sections: [
            {
              title: 'Experience',
              bullets: [
                {
                  text: 'Supported a team through research and clear writing.',
                  fact_ids: [fact.id],
                },
              ],
            },
          ],
        },
      })
      .returning({ id: resumeVersions.id });
    return resume.id;
  }

  async function preparedHandoff(
    opportunityId: string,
    source: 'approved_pdf' | 'employer_link' = 'employer_link',
    resumeId?: string,
  ) {
    const result = await createApplicationHandoff(
      userAId,
      { opportunityId, source, ...(resumeId ? { resumeId } : {}) },
      database,
    );
    if (result.outcome === 'skipped')
      throw new Error('Expected an active application handoff.');
    return result.handoff;
  }

  it('keeps the handoff private, dismisses Not yet, then marks applied only after Yes', async () => {
    const opportunityId = await preparingRole();
    await expect(
      createApplicationHandoff(
        userAId,
        { opportunityId, source: 'employer_link' },
        database,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'APPROVED_PDF_REQUIRED' });
    await approvedResume(opportunityId);
    const handoff = await preparedHandoff(opportunityId);
    expect(
      await listPendingApplicationHandoffs(userAId, database),
    ).toHaveLength(1);
    expect(await listPendingApplicationHandoffs(userBId, database)).toEqual([]);
    await expect(
      answerApplicationHandoff(
        userBId,
        handoff.id,
        { answer: 'applied' },
        database,
      ),
    ).rejects.toMatchObject({ status: 404 });

    await answerApplicationHandoff(
      userAId,
      handoff.id,
      { answer: 'not_yet' },
      database,
    );
    expect(
      (
        await database
          .select({ status: opportunities.status })
          .from(opportunities)
          .where(eq(opportunities.id, opportunityId))
      )[0].status,
    ).toBe('preparing');
    expect(await listPendingApplicationHandoffs(userAId, database)).toEqual([]);

    const nextHandoff = await preparedHandoff(opportunityId);
    const answers = await Promise.all([
      answerApplicationHandoff(
        userAId,
        nextHandoff.id,
        { answer: 'applied' },
        database,
      ),
      answerApplicationHandoff(
        userAId,
        nextHandoff.id,
        { answer: 'applied' },
        database,
      ),
    ]);
    expect(
      answers.map(({ alreadyAnswered }) => alreadyAnswered).sort(),
    ).toEqual([false, true]);
    expect(answers[0].handoff.response).toBe('applied');
    expect(
      (
        await database
          .select({ status: opportunities.status })
          .from(opportunities)
          .where(eq(opportunities.id, opportunityId))
      )[0].status,
    ).toBe('applied');
    await expect(
      answerApplicationHandoff(
        userAId,
        nextHandoff.id,
        { answer: 'not_yet' },
        database,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects handoff records for roles outside preparation', async () => {
    const { opportunity } = await createJob(
      userAId,
      {
        title: 'Saved role',
        company: 'Example',
        text: 'This role includes research, communication, planning, and teamwork. '.repeat(
          3,
        ),
      },
      { database },
    );
    await expect(
      createApplicationHandoff(
        userAId,
        { opportunityId: opportunity.id, source: 'employer_link' },
        database,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    'applied',
    'interviewing',
    'offer',
    'rejected',
    'withdrawn',
  ] as const)(
    'downloads an approved CV for a %s role without creating a new check-in',
    async (status) => {
      const opportunityId = await preparingRole();
      const resumeId = await approvedResume(opportunityId);
      await updateOpportunityStatus(userAId, opportunityId, status, database);

      await expect(
        createApplicationHandoff(
          userAId,
          { opportunityId, source: 'approved_pdf', resumeId },
          database,
        ),
      ).resolves.toEqual({
        outcome: 'skipped',
        reason: 'role_already_advanced',
      });
      await expect(
        createApplicationHandoff(
          userAId,
          { opportunityId, source: 'employer_link', resumeId },
          database,
        ),
      ).rejects.toMatchObject({ status: 409, code: 'ROLE_NOT_PREPARING' });

      expect(
        await database
          .select()
          .from(applicationHandoffs)
          .where(eq(applicationHandoffs.opportunityId, opportunityId)),
      ).toEqual([]);
      expect(
        (
          await database
            .select({ status: opportunities.status })
            .from(opportunities)
            .where(eq(opportunities.id, opportunityId))
        )[0].status,
      ).toBe(status);
    },
  );

  it('returns not found for malformed handoff ids before querying PostgreSQL', async () => {
    await expect(
      answerApplicationHandoff(
        userAId,
        'not-a-uuid',
        { answer: 'applied' },
        database,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('lets only one conflicting concurrent answer commit, with matching status and events', async () => {
    const opportunityId = await preparingRole();
    await approvedResume(opportunityId);
    const handoff = await preparedHandoff(opportunityId);
    const priorStatusEvents = await database
      .select()
      .from(events)
      .where(
        and(
          eq(events.userId, userAId),
          eq(events.subjectId, opportunityId),
          eq(events.type, 'opportunity.status_changed'),
        ),
      );
    const attempts = await Promise.allSettled([
      answerApplicationHandoff(
        userAId,
        handoff.id,
        { answer: 'applied' },
        database,
      ),
      answerApplicationHandoff(
        userAId,
        handoff.id,
        { answer: 'not_yet' },
        database,
      ),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = attempts.find((item) => item.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { status: 409 },
    });

    const [savedHandoff] = await database
      .select()
      .from(applicationHandoffs)
      .where(eq(applicationHandoffs.id, handoff.id));
    const [savedOpportunity] = await database
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunityId));
    const answerEvents = await database
      .select()
      .from(events)
      .where(
        and(eq(events.userId, userAId), eq(events.subjectId, opportunityId)),
      );
    const applicationEvents = answerEvents.filter(
      (event) =>
        event.type === 'application.confirmed_applied' ||
        event.type === 'application.not_yet',
    );
    const statusEvents = answerEvents.filter(
      (event) => event.type === 'opportunity.status_changed',
    );
    expect(applicationEvents).toHaveLength(1);
    if (savedHandoff.response === 'applied') {
      expect(savedOpportunity.status).toBe('applied');
      expect(statusEvents).toHaveLength(priorStatusEvents.length + 1);
      expect(applicationEvents[0].type).toBe('application.confirmed_applied');
    } else {
      expect(savedHandoff.response).toBe('not_yet');
      expect(savedOpportunity.status).toBe('preparing');
      expect(statusEvents).toHaveLength(priorStatusEvents.length);
      expect(applicationEvents[0].type).toBe('application.not_yet');
    }
  });

  it('blocks handoff creation and answers while account deletion is pending', async () => {
    const opportunityId = await preparingRole();
    await approvedResume(opportunityId);
    const handoff = await preparedHandoff(opportunityId);
    await database
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, userAId));
    try {
      await expect(
        createApplicationHandoff(
          userAId,
          { opportunityId, source: 'employer_link' },
          database,
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'ACCOUNT_DELETION_PENDING',
      });
      await expect(
        answerApplicationHandoff(
          userAId,
          handoff.id,
          { answer: 'applied' },
          database,
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'ACCOUNT_DELETION_PENDING',
      });
      const [savedHandoff] = await database
        .select()
        .from(applicationHandoffs)
        .where(eq(applicationHandoffs.id, handoff.id));
      const [savedOpportunity] = await database
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, opportunityId));
      expect(savedHandoff.response).toBeNull();
      expect(savedOpportunity.status).toBe('preparing');
    } finally {
      await database
        .update(users)
        .set({ deletionRequestedAt: null })
        .where(eq(users.id, userAId));
    }
  });
});
