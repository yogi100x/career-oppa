import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, users, type Database } from '@career-workspace/db';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import { balance } from './credits';
import { createJob } from './roles';
import { createPractice, getPractice, submitPracticeAnswers } from './practice';

const integration = process.env.DATABASE_TEST_URL ? describe : describe.skip;
const questions = [
  { question: 'Describe a useful interface you built.', focus: 'Evidence' },
  { question: 'How do you check an interface works?', focus: 'Testing' },
  { question: 'How would you learn an unfamiliar tool?', focus: 'Learning' },
];
const answers = [
  'I built a small form.',
  'I click through the main flow.',
  'I read the documentation and build a small example.',
];
const feedback = {
  overall: 'Give more concrete examples.',
  strengths: ['You describe practical steps.'],
  improvements: ['Explain how you checked the result.'],
  nextSteps: ['Practice one specific example.'],
};
const recorded = () =>
  createRecordedResponseGenerator({
    'practice-questions.v1': { questions },
    'practice-feedback.v1': feedback,
  });

integration('interview practice with included feedback', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  let otherId: string;
  let opportunityId: string;
  beforeAll(async () => {
    const result = createDatabase(process.env.DATABASE_TEST_URL!);
    database = result.database;
    pool = result.pool;
    const people = await database
      .insert(users)
      .values([
        { clerkId: `practice-a-${randomUUID()}` },
        { clerkId: `practice-b-${randomUUID()}` },
      ])
      .returning();
    [userId, otherId] = people.map((person) => person.id);
    const role = await createJob(
      userId,
      {
        title: 'Junior developer',
        company: 'Practice fixture',
        text: 'Build accessible web tools with TypeScript, work closely with product colleagues, review changes, and document practical decisions for customers.',
      },
      { database },
    );
    opportunityId = role.opportunity.id;
  });
  afterAll(async () => {
    if (database)
      await database.delete(users).where(inArray(users.id, [userId, otherId]));
    if (pool) await pool.end();
  });

  it('charges three credits once and includes saved feedback and retries', async () => {
    const options = { database, generate: recorded() };
    const session = await createPractice(
      userId,
      opportunityId,
      'first',
      options,
    );
    expect(
      (await createPractice(userId, opportunityId, 'first', options)).id,
    ).toBe(session.id);
    expect((await balance(userId, { database })).available).toBe(27);
    const completed = await submitPracticeAnswers(
      userId,
      session.id,
      { answers, confirmed: true },
      options,
    );
    expect(completed.status).toBe('completed');
    expect(completed.feedback).toEqual(feedback);
    expect(
      (
        await submitPracticeAnswers(
          userId,
          session.id,
          { answers, confirmed: true },
          options,
        )
      ).id,
    ).toBe(session.id);
    expect((await balance(userId, { database })).available).toBe(27);
    await expect(
      submitPracticeAnswers(
        userId,
        session.id,
        {
          answers: answers.map((answer) => `${answer} Changed.`),
          confirmed: true,
        },
        options,
      ),
    ).rejects.toMatchObject({ code: 'SESSION_COMPLETED' });
    await expect(
      getPractice(otherId, session.id, database),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('releases a failed question-generation reservation', async () => {
    const before = await balance(userId, { database });
    const fail: typeof recorded extends () => infer R
      ? R
      : never = async () => {
      throw new Error('provider unavailable');
    };
    await expect(
      createPractice(userId, opportunityId, 'failed', {
        database,
        generate: fail,
      }),
    ).rejects.toThrow('provider unavailable');
    expect((await balance(userId, { database })).available).toBe(
      before.available,
    );
  });

  it('keeps submitted answers after failed feedback and retries without another charge', async () => {
    const session = await createPractice(
      userId,
      opportunityId,
      'feedback-retry',
      { database, generate: recorded() },
    );
    const before = await balance(userId, { database });
    const fail: ReturnType<typeof recorded> = async () => {
      throw new Error('feedback unavailable');
    };
    await expect(
      submitPracticeAnswers(
        userId,
        session.id,
        { answers, confirmed: true },
        { database, generate: fail },
      ),
    ).rejects.toThrow('feedback unavailable');
    const saved = await getPractice(userId, session.id, database);
    expect(saved.status).toBe('questions_ready');
    expect(saved.answers).toEqual(answers);
    expect(
      (
        await submitPracticeAnswers(
          userId,
          session.id,
          { answers, confirmed: true },
          { database, generate: recorded() },
        )
      ).status,
    ).toBe('completed');
    expect((await balance(userId, { database })).available).toBe(
      before.available,
    );
    await expect(
      submitPracticeAnswers(
        userId,
        session.id,
        { answers: answers.slice(0, 2), confirmed: true },
        { database, generate: recorded() },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
