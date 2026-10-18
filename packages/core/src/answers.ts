import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  getDatabase,
  answerDrafts,
  profileFacts,
  users,
  type Database,
} from '@career-workspace/db';
import {
  answerContentSchema,
  createAnswerSchema,
} from '@career-workspace/contracts';
import {
  generateStructured,
  answerDraftPrompt,
} from '@career-workspace/adapters/ai';
import { ApiError } from './api';
import { getOpportunity } from './roles';
import { checkGrounding } from './grounding';
import { withCredits } from './credits';
import { recordEvent } from './events';

export async function getAnswer(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'Answer not found.');
  const [answer] = await database
    .select()
    .from(answerDrafts)
    .where(and(eq(answerDrafts.userId, userId), eq(answerDrafts.id, id)));
  if (!answer) throw new ApiError(404, 'NOT_FOUND', 'Answer not found.');
  return answer;
}
export async function listAnswers(
  userId: string,
  opportunityId: string,
  database: Database = getDatabase(),
) {
  await getOpportunity(userId, opportunityId, database);
  return database
    .select()
    .from(answerDrafts)
    .where(
      and(
        eq(answerDrafts.userId, userId),
        eq(answerDrafts.opportunityId, opportunityId),
      ),
    )
    .orderBy(desc(answerDrafts.createdAt));
}
export async function getAnswerGrounding(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  const answer = await getAnswer(userId, id, database);
  return checkGrounding(
    userId,
    [{ text: answer.answer, fact_ids: answer.factIds }],
    database,
  );
}
export async function createAnswer(
  userId: string,
  opportunityId: string,
  question: string,
  key: string,
  options: { database?: Database; generate?: typeof generateStructured } = {},
) {
  const database = options.database ?? getDatabase();
  const parsed = createAnswerSchema.safeParse({ question });
  if (!parsed.success || !key.trim() || key.length > 150)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Provide a question and request key.',
    );
  const { job } = await getOpportunity(userId, opportunityId, database);
  const facts = await database
    .select({ id: profileFacts.id, text: profileFacts.text })
    .from(profileFacts)
    .where(
      and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'approved')),
    );
  if (!facts.length)
    throw new ApiError(
      422,
      'NO_APPROVED_FACTS',
      'Approve some facts before drafting an answer.',
    );
  if (
    !options.generate &&
    (!process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY.startsWith('REPLACE_WITH_'))
  )
    throw new ApiError(
      503,
      'AI_NOT_CONFIGURED',
      'AI drafting is not configured yet. Your credits have not been charged.',
    );
  const result = await withCredits(
    userId,
    'answer_draft',
    `answer:${opportunityId}:${key}`,
    async () => {
      const generated = await (options.generate ?? generateStructured)(
        answerDraftPrompt,
        answerContentSchema,
        {
          question: parsed.data.question,
          jobText: job.text,
          approvedFacts: facts,
        },
      );
      const answer = await database.transaction(async (tx) => {
        const [saved] = await tx
          .insert(answerDrafts)
          .values({
            userId,
            opportunityId,
            question: parsed.data.question,
            answer: generated.object.answer,
            factIds: generated.object.fact_ids,
            promptVersion: generated.promptVersion,
            model: generated.model,
          })
          .returning();
        await recordEvent(
          {
            userId,
            type: 'answer.drafted',
            subjectType: 'opportunity',
            subjectId: opportunityId,
            data: { answerId: saved.id },
          },
          tx,
        );
        return saved;
      });
      return { type: 'answer', id: answer.id };
    },
    { database },
  );
  return getAnswer(userId, result.id, database);
}
export async function editAnswer(
  userId: string,
  id: string,
  input: { answer: string; fact_ids: string[] },
  database: Database = getDatabase(),
) {
  await getAnswer(userId, id, database);
  const parsed = answerContentSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Check the answer and supporting facts.',
    );
  return database.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    const [answer] = await tx
      .update(answerDrafts)
      .set({
        answer: parsed.data.answer,
        factIds: parsed.data.fact_ids,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(answerDrafts.userId, userId), eq(answerDrafts.id, id)))
      .returning();
    if (!answer) throw new ApiError(404, 'NOT_FOUND', 'Answer not found.');
    await recordEvent(
      {
        userId,
        type: 'answer.edited',
        subjectType: 'opportunity',
        subjectId: answer.opportunityId,
        data: { answerId: id },
      },
      tx,
    );
    return answer;
  });
}
export async function approveAnswer(
  userId: string,
  id: string,
  confirmedFactPairs: boolean,
  database: Database = getDatabase(),
) {
  if (!confirmedFactPairs)
    throw new ApiError(
      400,
      'CONFIRMATION_REQUIRED',
      'Confirm that the answer matches its supporting facts.',
    );
  await getAnswer(userId, id, database);
  return database.transaction(async (tx) => {
    // Match profile changes: user, answer, then supporting fact locks.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    const [answer] = await tx
      .select()
      .from(answerDrafts)
      .where(and(eq(answerDrafts.userId, userId), eq(answerDrafts.id, id)))
      .for('update');
    if (!answer) throw new ApiError(404, 'NOT_FOUND', 'Answer not found.');
    if (answer.factIds.length)
      await tx
        .select({ id: profileFacts.id })
        .from(profileFacts)
        .where(
          and(
            eq(profileFacts.userId, userId),
            inArray(profileFacts.id, answer.factIds),
          ),
        )
        .for('update');
    const grounding = await checkGrounding(
      userId,
      [{ text: answer.answer, fact_ids: answer.factIds }],
      tx,
    );
    if (!grounding.canApprove)
      throw new ApiError(
        422,
        'UNGROUNDED_CLAIMS',
        'Every claim needs approved supporting facts before approval.',
      );
    if (answer.approvedAt) return answer;
    const [approved] = await tx
      .update(answerDrafts)
      .set({ approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(answerDrafts.userId, userId), eq(answerDrafts.id, id)))
      .returning();
    await recordEvent(
      {
        userId,
        type: 'answer.approved',
        subjectType: 'opportunity',
        subjectId: answer.opportunityId,
        data: { answerId: id },
      },
      tx,
    );
    return approved;
  });
}
