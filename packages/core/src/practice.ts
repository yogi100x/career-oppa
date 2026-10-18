import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  getDatabase,
  practiceSessions,
  profileFacts,
  type Database,
} from '@career-workspace/db';
import {
  practiceAnswersSchema,
  practiceFeedbackSchema,
  practiceQuestionsSchema,
} from '@career-workspace/contracts';
import { generateStructured } from '@career-workspace/adapters/ai';
import { ApiError } from './api';
import { withCredits } from './credits';
import { getOpportunity } from './roles';
import { recordEvent } from './events';

const questionsPrompt = new URL(
  '../../adapters/src/ai/prompts/practice-questions.v1.md',
  import.meta.url,
);
const feedbackPrompt = new URL(
  '../../adapters/src/ai/prompts/practice-feedback.v1.md',
  import.meta.url,
);
type Options = { database?: Database; generate?: typeof generateStructured };
function requireAi(options: Options) {
  if (
    !options.generate &&
    (!process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY.startsWith('REPLACE_WITH_'))
  )
    throw new ApiError(
      503,
      'AI_NOT_CONFIGURED',
      'AI practice is not configured yet. No extra credits have been charged.',
    );
}
const owned = (userId: string, id: string) =>
  and(eq(practiceSessions.userId, userId), eq(practiceSessions.id, id));

export async function getPractice(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'Practice session not found.');
  const [session] = await database
    .select()
    .from(practiceSessions)
    .where(owned(userId, id));
  if (!session)
    throw new ApiError(404, 'NOT_FOUND', 'Practice session not found.');
  return session;
}
export async function listPractice(
  userId: string,
  opportunityId: string,
  database: Database = getDatabase(),
) {
  await getOpportunity(userId, opportunityId, database);
  return database
    .select()
    .from(practiceSessions)
    .where(
      and(
        eq(practiceSessions.userId, userId),
        eq(practiceSessions.opportunityId, opportunityId),
      ),
    )
    .orderBy(desc(practiceSessions.createdAt));
}
export async function createPractice(
  userId: string,
  opportunityId: string,
  key: string,
  options: Options = {},
) {
  if (!key.trim() || key.length > 150)
    throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
  const database = options.database ?? getDatabase();
  const { job } = await getOpportunity(userId, opportunityId, database);
  const facts = await database
    .select({ id: profileFacts.id, text: profileFacts.text })
    .from(profileFacts)
    .where(
      and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'approved')),
    );
  requireAi(options);
  const result = await withCredits(
    userId,
    'practice_session',
    `practice:${opportunityId}:${key}`,
    async () => {
      const generated = await (options.generate ?? generateStructured)(
        questionsPrompt,
        practiceQuestionsSchema,
        { jobText: job.text, roleTitle: job.title, approvedFacts: facts },
      );
      const content = practiceQuestionsSchema.parse(generated.object);
      const saved = await database.transaction(async (tx) => {
        const [session] = await tx
          .insert(practiceSessions)
          .values({
            userId,
            opportunityId,
            questions: content.questions,
            questionPromptVersion: generated.promptVersion,
            model: generated.model,
          })
          .returning();
        await recordEvent(
          {
            userId,
            type: 'practice.started',
            subjectType: 'opportunity',
            subjectId: opportunityId,
            data: { practiceId: session.id },
          },
          tx,
        );
        return session;
      });
      return { type: 'practice', id: saved.id };
    },
    { database },
  );
  return getPractice(userId, result.id, database);
}

/** Feedback is included in the session price; retries never reserve more credits. */
export async function submitPracticeAnswers(
  userId: string,
  id: string,
  input: { answers: string[]; confirmed: true },
  options: Options = {},
) {
  const database = options.database ?? getDatabase();
  const parsed = practiceAnswersSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Answer every question and confirm your submission.',
    );
  const existing = await getPractice(userId, id, database);
  if (parsed.data.answers.length !== existing.questions.length)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Provide one answer for every question.',
    );
  const answerHash = createHash('sha256')
    .update(JSON.stringify(parsed.data.answers))
    .digest('hex');
  if (existing.status === 'completed' && existing.answerHash === answerHash)
    return existing;
  requireAi(options);
  const attempt = randomUUID();
  const started = await database.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(practiceSessions)
      .where(owned(userId, id))
      .for('update');
    if (!session)
      throw new ApiError(404, 'NOT_FOUND', 'Practice session not found.');
    if (session.status === 'completed') {
      if (session.answerHash !== answerHash)
        throw new ApiError(
          409,
          'SESSION_COMPLETED',
          'Start a new practice session for a new set of answers.',
        );
      return { replay: true as const, session };
    }
    if (session.answerHash && session.answerHash !== answerHash)
      throw new ApiError(
        409,
        'ANSWERS_CHANGED',
        'Retry the same submitted answers while feedback is pending.',
      );
    if (
      session.status === 'generating_feedback' &&
      session.updatedAt.getTime() > Date.now() - 120_000
    )
      throw new ApiError(
        409,
        'ACTION_IN_PROGRESS',
        'Feedback is already being prepared. Check again shortly.',
      );
    await tx
      .update(practiceSessions)
      .set({
        answers: parsed.data.answers,
        answerHash,
        status: 'generating_feedback',
        feedbackAttempt: attempt,
        updatedAt: new Date(),
      })
      .where(owned(userId, id));
    return { replay: false as const, session };
  });
  if (started.replay) return started.session;
  try {
    const { job } = await getOpportunity(
      userId,
      started.session.opportunityId,
      database,
    );
    const facts = await database
      .select({ text: profileFacts.text })
      .from(profileFacts)
      .where(
        and(
          eq(profileFacts.userId, userId),
          eq(profileFacts.status, 'approved'),
        ),
      );
    const generated = await (options.generate ?? generateStructured)(
      feedbackPrompt,
      practiceFeedbackSchema,
      {
        jobText: job.text,
        questions: started.session.questions,
        answers: parsed.data.answers,
        approvedFacts: facts,
      },
    );
    const feedback = practiceFeedbackSchema.parse(generated.object);
    return await database.transaction(async (tx) => {
      const [saved] = await tx
        .update(practiceSessions)
        .set({
          feedback,
          feedbackPromptVersion: generated.promptVersion,
          model: generated.model,
          status: 'completed',
          updatedAt: new Date(),
        })
        .where(
          and(owned(userId, id), eq(practiceSessions.feedbackAttempt, attempt)),
        )
        .returning();
      if (!saved)
        throw new ApiError(
          409,
          'ATTEMPT_REPLACED',
          'A newer feedback attempt is running. Check again shortly.',
        );
      await recordEvent(
        {
          userId,
          type: 'practice.feedback_ready',
          subjectType: 'opportunity',
          subjectId: saved.opportunityId,
          data: { practiceId: id },
        },
        tx,
      );
      return saved;
    });
  } catch (error) {
    await database
      .update(practiceSessions)
      .set({ status: 'questions_ready', updatedAt: new Date() })
      .where(
        and(
          owned(userId, id),
          eq(practiceSessions.feedbackAttempt, attempt),
          eq(practiceSessions.status, 'generating_feedback'),
        ),
      );
    throw error;
  }
}
