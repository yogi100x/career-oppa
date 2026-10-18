import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import {
  createDatabase,
  creditHolds,
  profileFacts,
  users,
  type Database,
} from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance } from './credits';
import {
  approveAnswer,
  createAnswer,
  editAnswer,
  getAnswer,
  listAnswers,
} from './answers';
import { createJob } from './roles';
import { updateProfileFact } from './profile';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('application answers with recorded generator', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userAId: string;
  let userBId: string;
  let factId: string;
  let opportunityAId: string;
  let opportunityBId: string;
  let answerId: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test') {
      throw new Error('Use career_workspace_test only.');
    }
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;

    const [userA, userB] = await database
      .insert(users)
      .values([
        { clerkId: `answer-test-a-${randomUUID()}` },
        { clerkId: `answer-test-b-${randomUUID()}` },
      ])
      .returning({ id: users.id });
    userAId = userA.id;
    userBId = userB.id;

    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId: userAId,
        kind: 'achievement',
        text: 'Built a customer-facing TypeScript application',
        source: 'user',
        status: 'proposed',
      })
      .returning({ id: profileFacts.id });
    factId = fact.id;
    await updateProfileFact(userAId, factId, { status: 'approved' }, database);

    const roleText =
      'Build and maintain dependable customer-facing web applications with a modern TypeScript stack. ' +
      'Work closely with product and design, write clear tests, review code, and improve application ' +
      'performance and accessibility. Communicate project decisions and help the team deliver reliable software.';
    const [roleA, roleB] = await Promise.all([
      createJob(
        userAId,
        { title: 'Product Engineer', company: 'Answer Test A', text: roleText },
        { database },
      ),
      createJob(
        userBId,
        { title: 'Product Engineer', company: 'Answer Test B', text: roleText },
        { database },
      ),
    ]);
    opportunityAId = roleA.opportunity.id;
    opportunityBId = roleB.opportunity.id;
  });

  afterAll(async () => {
    if (userAId && userBId) {
      await database.delete(users).where(inArray(users.id, [userAId, userBId]));
    }
    await pool?.end();
  });

  it('charges once, replays the same answer, and requires pairing plus fresh approved facts', async () => {
    const generator = createRecordedResponseGenerator({
      'answer-draft.v1': {
        answer: 'I built a customer-facing TypeScript application.',
        fact_ids: [factId],
      },
    });
    const before = await balance(userAId, { database });
    const first = await createAnswer(
      userAId,
      opportunityAId,
      'Tell us about a relevant project.',
      'recorded-answer',
      { database, generate: generator },
    );
    answerId = first.id;
    const afterFirst = await balance(userAId, { database });
    const replay = await createAnswer(
      userAId,
      opportunityAId,
      'Tell us about a relevant project.',
      'recorded-answer',
      { database, generate: generator },
    );
    const afterReplay = await balance(userAId, { database });

    expect(first.id).toBe(replay.id);
    expect(afterFirst.available).toBe(before.available - 1);
    expect(afterReplay.available).toBe(afterFirst.available);
    expect(first.promptVersion).toBe('answer-draft.v1');
    expect(first.approvedAt).toBeNull();

    await expect(
      approveAnswer(userAId, answerId, false, database),
    ).rejects.toMatchObject({ status: 400, code: 'CONFIRMATION_REQUIRED' });
    await updateProfileFact(userAId, factId, { status: 'rejected' }, database);
    await expect(
      approveAnswer(userAId, answerId, true, database),
    ).rejects.toMatchObject({ status: 422, code: 'UNGROUNDED_CLAIMS' });

    await updateProfileFact(userAId, factId, { status: 'approved' }, database);
    const approved = await approveAnswer(userAId, answerId, true, database);
    expect(approved.approvedAt).toBeInstanceOf(Date);

    const edited = await editAnswer(
      userAId,
      answerId,
      {
        answer: 'I improved the same application after user feedback.',
        fact_ids: [factId],
      },
      database,
    );
    expect(edited.approvedAt).toBeNull();

    await updateProfileFact(userAId, factId, { status: 'rejected' }, database);
    await expect(
      approveAnswer(userAId, answerId, true, database),
    ).rejects.toMatchObject({ status: 422, code: 'UNGROUNDED_CLAIMS' });
  });

  it('releases its hold and charges nothing after a generator error', async () => {
    await updateProfileFact(userAId, factId, { status: 'approved' }, database);
    const before = await balance(userAId, { database });
    const requestKey = 'provider-error';
    const idempotencyKey = `${userAId}:answer:${opportunityAId}:${requestKey}`;
    await expect(
      createAnswer(
        userAId,
        opportunityAId,
        'Describe a difficult project.',
        requestKey,
        {
          database,
          generate: async () => {
            throw new Error('Recorded answer provider failure');
          },
        },
      ),
    ).rejects.toThrow('Recorded answer provider failure');
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

  it('does not let user B read or edit user A’s answer', async () => {
    const beforeB = await balance(userBId, { database });
    await expect(getAnswer(userBId, answerId, database)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      editAnswer(
        userBId,
        answerId,
        { answer: 'Cross-user edit.', fact_ids: [factId] },
        database,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      approveAnswer(userBId, answerId, true, database),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      listAnswers(userBId, opportunityAId, database),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(await listAnswers(userBId, opportunityBId, database)).toEqual([]);
    expect(await getAnswer(userAId, answerId, database)).toMatchObject({
      id: answerId,
      userId: userAId,
    });
    expect((await balance(userBId, { database })).available).toBe(
      beforeB.available,
    );
  });
});
