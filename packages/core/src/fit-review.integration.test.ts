import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { createRecordedResponseGenerator, generateStructured } from '@career-workspace/adapters/ai';
import {
  createDatabase,
  creditHolds,
  fitReviews,
  opportunities,
  profileFacts,
  users,
  type Database,
} from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance } from './credits';
import { ApiError } from './api';
import { createFitReview, getFitReviewEligibility, getFitReviews } from './fit-review';
import { createJob } from './roles';
import { updateProfileFact } from './profile';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('fit review with recorded generator', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userAId: string;
  let userBId: string;
  let userCId: string;
  let userDId: string;
  let legacyUserId: string;
  let factId: string;
  let unapprovedFactId: string;
  let opportunityAId: string;
  let opportunityBId: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test') {
      throw new Error('Use career_workspace_test only.');
    }
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;

    const [userA, userB, userC, userD] = await database
      .insert(users)
      .values([
        { clerkId: `fit-review-a-${randomUUID()}` },
        { clerkId: `fit-review-b-${randomUUID()}` },
        { clerkId: `fit-review-c-${randomUUID()}` },
        { clerkId: `fit-review-d-${randomUUID()}` },
      ])
      .returning({ id: users.id });
    userAId = userA.id;
    userBId = userB.id;
    userCId = userC.id;
    userDId = userD.id;

    const [approvedFact, unapprovedFact] = await database
      .insert(profileFacts)
      .values([
        {
          userId: userAId,
          kind: 'skill',
          text: 'Built production TypeScript software',
          source: 'user',
          status: 'proposed',
        },
        {
          userId: userAId,
          kind: 'achievement',
          text: 'Unapproved claim',
          source: 'user',
          status: 'proposed',
        },
        {
          userId: userBId,
          kind: 'skill',
          text: 'B owned skill',
          source: 'user',
          status: 'approved',
        },
      ])
      .returning({ id: profileFacts.id });
    factId = approvedFact.id;
    unapprovedFactId = unapprovedFact.id;
    await updateProfileFact(userAId, factId, { status: 'approved' }, database);

    const role =
      'The engineer will build and maintain reliable web software, work with product teams, ' +
      'write clear tests, review code, and improve the performance and accessibility of ' +
      'customer-facing applications. Candidates should communicate well and be comfortable ' +
      'working across a modern TypeScript stack.';
    const [roleA, roleB] = await Promise.all([
      createJob(
        userAId,
        { title: 'Frontend Engineer', company: 'Example A', text: role },
        { database },
      ),
      createJob(
        userBId,
        { title: 'Frontend Engineer', company: 'Example B', text: role },
        { database },
      ),
    ]);
    opportunityAId = roleA.opportunity.id;
    opportunityBId = roleB.opportunity.id;
  });

  afterAll(async () => {
    if (userAId && userBId && userCId && userDId) {
      await database.delete(users).where(inArray(users.id, [userAId, userBId, userCId, userDId, ...(legacyUserId ? [legacyUserId] : [])]));
    }
    await pool?.end();
  });

  it('makes the first review free and replays it for the same key', async () => {
    const generator = createRecordedResponseGenerator({
      'fit-review.v5': {
        verdict: 'Good fit for the core engineering work.',
        requirements: [
          {
            text: 'Has production TypeScript experience.',
            importance: 'essential',
            status: 'met',
            fact_ids: [factId],
            job_quote: 'a modern TypeScript stack',
          },
          {
            text: 'Writes clear tests.',
            importance: 'desirable',
            status: 'met',
            fact_ids: [unapprovedFactId],
            job_quote: 'write clear tests',
          },
          {
            text: 'Accessibility experience',
            importance: 'essential',
            status: 'unknown',
            fact_ids: [],
            job_quote: 'accessibility of\n customer-facing applications',
          },
          {
            text: 'Pilot licence',
            importance: 'essential',
            status: 'gap',
            fact_ids: [],
            job_quote: 'must hold a commercial pilot licence',
          },
        ],
      },
    });
    const before = await balance(userAId, { database });
    expect(await getFitReviewEligibility(userAId, database)).toEqual({ firstReviewFree: true });
    const first = await createFitReview(
      userAId,
      opportunityAId,
      'recorded-fit-review',
      { database, generate: generator },
    );
    const afterFirst = await balance(userAId, { database });
    const replay = await createFitReview(
      userAId,
      opportunityAId,
      'recorded-fit-review',
      { database, generate: generator },
    );
    const afterReplay = await balance(userAId, { database });

    expect(first.id).toBe(replay.id);
    expect(afterFirst.available).toBe(before.available);
    expect(first.isFree).toBe(true);
    expect(await getFitReviewEligibility(userAId, database)).toEqual({ firstReviewFree: false });
    expect(afterReplay.available).toBe(afterFirst.available);
    expect(first.strengths).toEqual([
      { text: 'Has production TypeScript experience.', fact_ids: [factId] },
    ]);
    // Thin evidence stays unknown; quotes absent from the job are dropped.
    expect(first.gaps).toEqual([]);
    expect(first.unknowns).toContain('Accessibility experience');
    expect(JSON.stringify(first)).not.toContain('Pilot licence');
    expect(first.unknowns[0]).toMatch(/could not be matched/);
    expect(JSON.stringify(first.strengths)).not.toContain('Writes clear tests');
    expect(first.requirements?.find(row => row.text === 'Writes clear tests.')).toMatchObject({ status: 'unknown', fact_ids: [] });
    const nextRole = await createJob(userAId, {
      title: 'Another Engineer',
      company: 'Example A',
      text: 'Build reliable web software, write clear tests, review code, improve customer applications, work across teams, and support accessible product experiences.',
    }, { database });
    const paidGenerator = createRecordedResponseGenerator({
      'fit-review.v5': { verdict: 'Review generated.', requirements: [] },
    });
    await expect(createFitReview(userAId, nextRole.opportunity.id, 'recorded-fit-review', {
      database,
      generate: paidGenerator,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    const staleBalance = await balance(userAId, { database });
    await expect(createFitReview(userAId, nextRole.opportunity.id, 'stale-free-label', {
      database,
      generate: paidGenerator,
      requireFree: true,
    })).rejects.toMatchObject({ code: 'FREE_REVIEW_UNAVAILABLE' });
    expect((await balance(userAId, { database })).available).toBe(staleBalance.available);
    expect(await database.select({ id: creditHolds.id }).from(creditHolds)
      .where(and(eq(creditHolds.userId, userAId), eq(creditHolds.idempotencyKey, `${userAId}:fit:${nextRole.opportunity.id}:stale-free-label`)))).toEqual([]);
    const nextReview = await createFitReview(userAId, nextRole.opportunity.id, 'second-review', {
      database,
      generate: paidGenerator,
    });
    expect(nextReview.isFree).toBe(false);
    expect((await balance(userAId, { database })).available).toBe(before.available - 1);
  });

  it('does not offer a free review when a prior review exists without the marker', async () => {
    const [legacyUser] = await database.insert(users).values({ clerkId: `fit-review-legacy-${randomUUID()}` }).returning({ id: users.id });
    legacyUserId = legacyUser.id;
    const role = await createJob(legacyUserId, {
      title: 'Legacy Engineer', company: 'Example Legacy',
      text: 'Build reliable software, write tests, support production services, improve customer applications, and work with engineering teams.',
    }, { database });
    expect(await getFitReviewEligibility(legacyUserId, database)).toEqual({ firstReviewFree: true });
    const generator = createRecordedResponseGenerator({
      'fit-review.v5': { verdict: 'Review generated.', requirements: [] },
    });
    const prior = await createFitReview(legacyUserId, role.opportunity.id, 'prior-review', {
      database,
      generate: generator,
    });
    expect(prior.isFree).toBe(true);
    await database.update(users).set({ firstFitReviewUsed: false }).where(eq(users.id, legacyUserId));
    expect(await getFitReviewEligibility(legacyUserId, database)).toEqual({ firstReviewFree: false });
  });

  it('releases the free first review after failure, then retries successfully for free', async () => {
    const before = await balance(userCId, { database });
    const role = await createJob(userCId, {
      title: 'Backend Engineer', company: 'Example C',
      text: 'Build reliable backend services, write clear tests, support production systems using TypeScript, work with product teams, and improve the stability and performance of customer facing applications.',
    }, { database });
    await expect(createFitReview(userCId, role.opportunity.id, 'retry-free', {
      database,
      generate: async () => { throw new Error('temporary model failure'); },
    })).rejects.toMatchObject({ code: 'FIT_REVIEW_NOT_CHARGED' });
    expect(await getFitReviewEligibility(userCId, database)).toEqual({ firstReviewFree: true });
    const recorded = createRecordedResponseGenerator({
      'fit-review.v5': { verdict: 'Review generated.', requirements: [] },
    });
    const retried = await createFitReview(userCId, role.opportunity.id, 'retry-free', {
      database, generate: recorded,
    });
    expect(retried.isFree).toBe(true);
    expect((await balance(userCId, { database })).available).toBe(before.available);
    await database.delete(opportunities).where(eq(opportunities.id, role.opportunity.id));
    expect(await getFitReviewEligibility(userCId, database)).toEqual({ firstReviewFree: false });
    const laterRole = await createJob(userCId, {
      title: 'Cloud Engineer', company: 'Example C',
      text: 'Build cloud services, support production systems, improve reliability, work with engineering teams, and maintain customer facing applications securely.',
    }, { database });
    const laterReview = await createFitReview(userCId, laterRole.opportunity.id, 'later-paid-review', {
      database, generate: recorded,
    });
    expect(laterReview.isFree).toBe(false);
    expect((await balance(userCId, { database })).available).toBe(before.available - 1);
  });

  it('serializes concurrent first calls and replays the free result for the same key', async () => {
    const before = await balance(userDId, { database });
    const role = await createJob(userDId, {
      title: 'Platform Engineer', company: 'Example C',
      text: 'Build reliable cloud systems and support production services. Work with engineering teams, improve monitoring, automate deployments, and keep customer facing applications stable and available.',
    }, { database });
    const recorded = createRecordedResponseGenerator({
      'fit-review.v5': { verdict: 'Review generated.', requirements: [] },
    });
    let generated = 0;
    const generator: typeof generateStructured = async (prompt, schema, data) => {
      generated += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return recorded(prompt, schema, data);
    };
    const [first, second] = await Promise.all([
      createFitReview(userDId, role.opportunity.id, 'concurrent-free', { database, generate: generator }),
      createFitReview(userDId, role.opportunity.id, 'concurrent-free', { database, generate: generator }),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.isFree).toBe(true);
    expect(second.isFree).toBe(true);
    expect(generated).toBe(1);
    expect((await balance(userDId, { database })).available).toBe(before.available);
  });

  it('reviews a job before CV upload without inventing candidate strengths', async () => {
    await database.delete(profileFacts).where(eq(profileFacts.userId, userBId));
    let input: unknown;
    const recorded = createRecordedResponseGenerator({
      'fit-review.v5': {
        verdict:
          'Your personal fit is not known yet. Check these role requirements.',
        requirements: [
          {
            text: 'Invented experience',
            importance: 'essential',
            status: 'met',
            fact_ids: [factId],
            job_quote: 'modern TypeScript stack',
          },
          {
            text: 'Reviews code',
            importance: 'desirable',
            status: 'gap',
            fact_ids: [],
            job_quote: 'review code',
          },
        ],
      },
    });
    const before = await balance(userBId, { database });
    const result = await createFitReview(userBId, opportunityBId, 'job-first', {
      database,
      generate: async (prompt, schema, data) => {
        input = data;
        return recorded(prompt, schema, data);
      },
    });
    expect(input).toMatchObject({
      approvedFacts: [],
      evidenceAvailable: false,
    });
    expect(result.strengths).toEqual([]);
    expect(result.unknowns).toEqual([
      'Invented experience',
      'Unverified gap: Reviews code',
    ]);
    expect(result.gaps).toEqual([]);
    const initialReview = await getFitReviews(
      userBId,
      opportunityBId,
      database,
    );
    expect(initialReview[0]?.promptVersion).toContain(':no-approved-facts');
    expect(initialReview[0]?.outdated).toBe(false);
    expect((await balance(userBId, { database })).available).toBe(before.available);
    expect(initialReview[0]?.isFree).toBe(true);
  });

  it('marks a no-facts review stale after approval and refreshes only on an explicit paid action', async () => {
    const [legacyReview] = await database
      .select()
      .from(fitReviews)
      .where(
        and(
          eq(fitReviews.userId, userBId),
          eq(fitReviews.opportunityId, opportunityBId),
        ),
      );
    await database
      .update(fitReviews)
      .set({ promptVersion: 'fit-review.v5' })
      .where(eq(fitReviews.id, legacyReview.id));
    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId: userBId,
        kind: 'skill',
        text: 'TypeScript application development',
        source: 'user',
        status: 'approved',
      })
      .returning({ id: profileFacts.id });
    const stale = await getFitReviews(userBId, opportunityBId, database);
    expect(stale[0]?.outdated).toBe(true);
    const before = await balance(userBId, { database });
    const refreshed = await createFitReview(
      userBId,
      opportunityBId,
      'after-facts',
      {
        database,
        generate: createRecordedResponseGenerator({
          'fit-review.v5': {
            verdict:
              'Your approved facts now provide some evidence to compare.',
            requirements: [
              {
                text: 'Has TypeScript experience.',
                importance: 'essential',
                status: 'met',
                fact_ids: [fact.id],
                job_quote: 'TypeScript stack',
              },
            ],
          },
        }),
      },
    );
    expect(refreshed.strengths).toHaveLength(1);
    expect(refreshed.promptVersion).not.toContain(':no-approved-facts');
    expect(
      (await getFitReviews(userBId, opportunityBId, database))[0]?.outdated,
    ).toBe(false);
    expect((await balance(userBId, { database })).available).toBe(
      before.available - 1,
    );
  });

  it('moves a saved role to reviewed after its first review, never backwards', async () => {
    const recorded = createRecordedResponseGenerator({
      'fit-review.v5': {
        verdict: 'Some evidence to compare.',
        requirements: [],
      },
    });
    const text =
      'Support the operations team with weekly reporting, stakeholder updates and ' +
      'process improvements across a busy office. Clear writing and spreadsheet skills required.';
    const saved = await createJob(
      userAId,
      { title: 'Operations Intern', company: randomUUID(), text },
      { database },
    );
    const review = await createFitReview(
      userAId,
      saved.opportunity.id,
      'status-move',
      { database, generate: recorded },
    );
    expect(review.unknowns).toEqual([]);
    const [moved] = await database
      .select({
        status: opportunities.status,
        nextStep: opportunities.nextStep,
      })
      .from(opportunities)
      .where(eq(opportunities.id, saved.opportunity.id));
    expect(moved).toEqual({
      status: 'reviewed',
      nextStep: 'Decide whether to prepare an application',
    });

    const applied = await createJob(
      userAId,
      { title: 'Operations Intern', company: randomUUID(), text },
      { database },
    );
    await database
      .update(opportunities)
      .set({ status: 'applied' })
      .where(eq(opportunities.id, applied.opportunity.id));
    await createFitReview(userAId, applied.opportunity.id, 'no-move', {
      database,
      generate: recorded,
    });
    const [still] = await database
      .select({ status: opportunities.status })
      .from(opportunities)
      .where(eq(opportunities.id, applied.opportunity.id));
    expect(still.status).toBe('applied');
  });

  it('releases the hold after a provider error without charging', async () => {
    const before = await balance(userAId, { database });
    const idempotencyKey = `${userAId}:fit:${opportunityAId}:provider-error`;
    await expect(
      createFitReview(userAId, opportunityAId, 'provider-error', {
        database,
        generate: async () => {
          throw new Error('Recorded provider failure');
        },
      }),
    ).rejects.toMatchObject({ code: 'FIT_REVIEW_NOT_CHARGED', status: 502 });
    const after = await balance(userAId, { database });
    const [hold] = await database
      .select()
      .from(creditHolds)
      .where(
        and(
          eq(creditHolds.userId, userAId),
          eq(creditHolds.idempotencyKey, idempotencyKey),
        ),
      );

    expect(after.available).toBe(before.available);
    expect(hold?.status).toBe('released');
  });

  it('does not let user B create or read user A’s fit review', async () => {
    const beforeB = await balance(userBId, { database });
    const generator = createRecordedResponseGenerator({
      'fit-review.v5': {
        verdict: 'Should never be generated for the other user’s role.',
        requirements: [],
      },
    });
    await expect(
      createFitReview(userBId, opportunityAId, 'cross-user', {
        database,
        generate: generator,
      }),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
    await expect(
      getFitReviews(userBId, opportunityAId, database),
    ).rejects.toMatchObject({
      status: 404,
    });
    const afterB = await balance(userBId, { database });
    const bOwnReviews = await getFitReviews(userBId, opportunityBId, database);

    expect(afterB.available).toBe(beforeB.available);
    expect(bOwnReviews).toHaveLength(2);
    expect(bOwnReviews[0].opportunityId).toBe(opportunityBId);
  });
});
