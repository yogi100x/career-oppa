import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { streamCoach } from '@career-workspace/adapters/ai/coach';
import {
  createDatabase,
  coachMessages,
  creditHolds,
  ledgerEntries,
  rateLimits,
  tasks,
  users,
} from '@career-workspace/db';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { balance } from './credits';
import { getFitReviewEligibility } from './fit-review';
import { handleTelegramCommand } from './telegram-commands';
import { drainTelegramUpdates, receiveTelegramUpdate } from './telegram-bot';
import type { TelegramReply, TelegramUpdate } from './telegram-types';
import {
  consumeTelegramLinkCode,
  createTelegramLinkCode,
} from './telegram-links';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('Telegram message routing', () => {
  const { database, pool } = createDatabase(databaseUrl!);
  let userAId: string;
  let userBId: string;
  const chatA = `${Date.now() + Math.floor(Math.random() * 1_000_000)}`;
  const chatB = `${Number(chatA) + 1}`;
  const appUrl = 'https://career.example.test';
  const recordedReply = 'Recorded coach answer.';
  const streamedMessages: Array<
    Array<{ role: 'user' | 'assistant'; content: string }>
  > = [];
  const stream = vi.fn(async (options: Parameters<typeof streamCoach>[0]) => {
    streamedMessages.push(options.messages);
    return {
      toTextStreamResponse: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              void options
                .onFinish(recordedReply, {
                  model: 'recorded',
                  promptVersion: 'test',
                })
                .then(() => {
                  controller.enqueue(new TextEncoder().encode(recordedReply));
                  controller.close();
                })
                .catch((error: unknown) => controller.error(error));
            },
          }),
        ),
    } as Awaited<ReturnType<typeof streamCoach>>;
  });

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const rows = await database
      .insert(users)
      .values([
        { clerkId: `telegram-routing-a-${randomUUID()}` },
        { clerkId: `telegram-routing-b-${randomUUID()}` },
      ])
      .returning({ id: users.id });
    [userAId, userBId] = rows.map(({ id }) => id);
    for (const [userId, chatId] of [
      [userAId, chatA],
      [userBId, chatB],
    ] as const) {
      const linkUrl = (await createTelegramLinkCode(userId, { database })).url;
      const code = new URL(linkUrl).searchParams.get('start')!;
      expect(
        (await consumeTelegramLinkCode(code, chatId, chatId, { database }))
          .status,
      ).toBe('linked');
    }
  });

  afterAll(async () => {
    if (userAId) await database.delete(users).where(eq(users.id, userAId));
    if (userBId) await database.delete(users).where(eq(users.id, userBId));
    await pool.end();
  });

  beforeEach(async () => {
    stream.mockClear();
    streamedMessages.length = 0;
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    for (const userId of [userAId, userBId]) {
      await database
        .delete(rateLimits)
        .where(
          and(
            eq(rateLimits.actionKey, 'coach_chat'),
            eq(rateLimits.userId, userId),
          ),
        );
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  const update = (
    updateId: number,
    text: string,
    chatId = chatA,
    callbackData?: string,
  ): TelegramUpdate => ({
    updateId,
    text,
    chatId,
    telegramUserId: chatId,
    ...(callbackData ? { callbackData } : {}),
  });

  async function command(
    userId: string,
    updateId: number,
    text: string,
    chatId = chatA,
    callbackData?: string,
  ) {
    return handleTelegramCommand(
      userId,
      update(updateId, text, chatId, callbackData),
      { database, appUrl, stream },
    );
  }

  it('explains that the first fit review is free', async () => {
    const credits = await command(userAId, 9_200_100, '/credits');
    const help = await command(userAId, 9_200_101, '/help');
    expect(credits.map(({ text }) => text).join('\n')).toContain(
      'Fit review: first review free, then 1 credit',
    );
    expect(help.map(({ text }) => text).join('\n')).toContain(
      'fit review (first review free, then 1 credit, confirmed first)',
    );
  });

  async function choiceFor(text: string, updateId: number) {
    const replies = await command(userAId, updateId, text);
    const buttons = replies.flatMap((reply) => reply.buttons ?? []);
    const [jobButton, questionButton] = buttons;
    const { firstReviewFree } = await getFitReviewEligibility(
      userAId,
      database,
    );
    expect(buttons.map(({ text: label }) => label)).toEqual([
      firstReviewFree
        ? 'Review this job (first review free)'
        : 'Review this job (1 credit)',
      'It is a question',
    ]);
    expect(jobButton?.data).toMatch(/^j:[0-9a-f-]{36}$/i);
    expect(questionButton?.data).toMatch(/^q:[0-9a-f-]{36}$/i);
    expect(jobButton!.data!.length).toBeLessThan(40);
    expect(questionButton!.data!.length).toBeLessThan(40);
    return {
      taskId: jobButton!.data!.slice(2),
      jobCallback: jobButton!.data!,
      questionCallback: questionButton!.data!,
      replies,
    };
  }

  it('routes a 150-character question to the recorded coach', async () => {
    const question =
      'What is the best way to explain my project leadership experience in an interview? ' +
      'I want the answer to sound clear, specific, and confident before I speak with the team.';
    expect(question.length).toBeGreaterThanOrEqual(150);
    expect(question.length).toBeLessThan(200);
    const replies = await command(userAId, 9_200_001, question);
    expect(replies.map(({ text }) => text).join('\n')).toContain(recordedReply);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(streamedMessages[0]?.at(-1)).toEqual({
      role: 'user',
      content: question,
    });
  });

  it('routes long descriptions and multiline job signals to review confirmation', async () => {
    const longDescription =
      'Senior software engineer. ' +
      'Responsibilities include building reliable services, collaborating with product teams, and writing clear tests. '.repeat(
        4,
      );
    const multilineSignals =
      'Senior Product Designer\nResponsibilities\nWork with product and engineering teams\nRequirements\nExperience with user research';
    const urlAndJobText =
      'https://jobs.example.test/role\nResponsibilities include working with product teams. Requirements include clear communication and reliable delivery.';
    const longReplies = await command(userAId, 9_200_002, longDescription);
    const multilineReplies = await command(
      userAId,
      9_200_003,
      multilineSignals,
    );
    const urlReplies = await command(userAId, 9_200_015, urlAndJobText);
    for (const replies of [longReplies, multilineReplies, urlReplies]) {
      expect(replies.map(({ text }) => text).join('\n')).toContain(
        'Your first job fit review is free. Would you like to continue?',
      );
      expect(
        replies.flatMap((reply) => reply.buttons ?? []).map(({ text }) => text),
      ).toContain('Review (free first review)');
      expect(replies.map(({ text }) => text).join('\n')).toMatch(
        /costs 1 credit|first job fit review is free|confirm/i,
      );
      expect(
        replies.flatMap((reply) => reply.buttons ?? []).map((b) => b.data),
      ).toContainEqual(expect.stringMatching(/^review:[0-9a-f-]{36}$/i));
    }
    const mixedJobId = urlReplies[0].buttons![0].data!.slice('review:'.length);
    const [mixedJob] = await database
      .select()
      .from(tasks)
      .where(eq(tasks.id, mixedJobId));
    expect((mixedJob.input as { text: string }).text).toBe(urlAndJobText);
    expect((mixedJob.input as { url?: string }).url).toBeUndefined();
    expect(stream).not.toHaveBeenCalled();
  });

  it('stores ambiguous text and asks exactly which action the user wants without charging', async () => {
    const ambiguous =
      'I am considering a new direction and want to understand how my recent work could fit into it. ' +
      'I have experience across several teams and would like a useful next step.';
    expect(ambiguous.length).toBeGreaterThanOrEqual(120);
    expect(ambiguous.length).toBeLessThan(300);
    const before = await balance(userAId, { database });
    const holdsBefore = await database
      .select()
      .from(creditHolds)
      .where(eq(creditHolds.userId, userAId));
    const ledgerBefore = await database
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, userAId));
    const beforeStreamCount = stream.mock.calls.length;
    const { taskId, replies } = await choiceFor(ambiguous, 9_200_004);
    const [task] = await database
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));
    expect(task.userId).toBe(userAId);
    expect(task.kind).toBe('telegram_choice');
    expect((task.input as { text?: string }).text).toBe(ambiguous);
    expect(replies).toHaveLength(1);
    expect((await balance(userAId, { database })).available).toBe(
      before.available,
    );
    expect(stream).toHaveBeenCalledTimes(beforeStreamCount);
    expect(
      await database
        .select()
        .from(creditHolds)
        .where(eq(creditHolds.userId, userAId)),
    ).toHaveLength(holdsBefore.length);
    expect(
      await database
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, userAId)),
    ).toHaveLength(ledgerBefore.length);
  });

  it('reuses one pending job when the same originating Telegram update is retried', async () => {
    const ambiguous =
      'I am considering a new direction and want to understand how my recent work could fit into it. ' +
      'I have experience across several teams and would like a useful next step.';
    const first = await choiceFor(ambiguous, 9_200_005);
    const replay = await choiceFor(ambiguous, 9_200_005);
    expect(replay.taskId).toBe(first.taskId);
    expect(replay.jobCallback).toBe(first.jobCallback);
  });

  it('turns the job choice into the existing review confirmation without starting work', async () => {
    const ambiguous =
      'I am considering a new direction and want to understand how my recent work could fit into it. ' +
      'I have experience across several teams and would like a useful next step.';
    const choice = await choiceFor(ambiguous, 9_200_006);
    const before = await balance(userAId, { database });
    const result = await command(
      userAId,
      9_200_007,
      '',
      chatA,
      choice.jobCallback,
    );
    expect(result.map(({ text }) => text).join('\n')).toContain(
      'Your first job fit review is free. Would you like to continue?',
    );
    expect(
      result.flatMap((reply) => reply.buttons ?? []).map(({ text }) => text),
    ).toContain('Review (free first review)');
    const reviewId = result
      .flatMap((reply) => reply.buttons ?? [])
      .find(({ data }) => data?.startsWith('review:'))
      ?.data?.slice('review:'.length);
    expect(reviewId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(
      result.flatMap((reply) => reply.buttons ?? []).map(({ data }) => data),
    ).toContain(`review:${reviewId}`);
    expect(stream).not.toHaveBeenCalled();
    expect((await balance(userAId, { database })).available).toBe(
      before.available,
    );
    const repeatedPress = await command(
      userAId,
      9_200_016,
      '',
      chatA,
      choice.jobCallback,
    );
    expect(
      repeatedPress
        .flatMap((reply) => reply.buttons ?? [])
        .map(({ data }) => data),
    ).toContain(`review:${reviewId}`);
    const [task] = await database
      .select()
      .from(tasks)
      .where(eq(tasks.id, reviewId!));
    expect(task.kind).toBe('telegram_job');
    expect((task.input as { text?: string }).text).toBe(ambiguous);
    expect(task.status).toBe('queued');
  });

  it('runs the question choice once per callback update and keeps the source text', async () => {
    const ambiguous =
      'I am considering a new direction and want to understand how my recent work could fit into it. ' +
      'I have experience across several teams and would like a useful next step.';
    const choice = await choiceFor(ambiguous, 9_200_008);
    const callbackUpdateId = 9_200_009;
    const first = await command(
      userAId,
      callbackUpdateId,
      '',
      chatA,
      choice.questionCallback,
    );
    const replay = await command(
      userAId,
      callbackUpdateId,
      '',
      chatA,
      choice.questionCallback,
    );
    expect(first.map(({ text }) => text).join('\n')).toContain(recordedReply);
    expect(replay.map(({ text }) => text).join('\n')).toContain(recordedReply);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(streamedMessages[0]?.at(-1)).toEqual({
      role: 'user',
      content: ambiguous,
    });
    const messages = await database
      .select()
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.userId, userAId),
          eq(coachMessages.requestKey, `telegram:${callbackUpdateId}`),
        ),
      );
    expect(messages.filter(({ role }) => role === 'user')).toHaveLength(1);
    const [allowance] = await database
      .select()
      .from(rateLimits)
      .where(
        and(
          eq(rateLimits.userId, userAId),
          eq(rateLimits.actionKey, 'coach_chat'),
        ),
      );
    expect(allowance.count).toBe(1);
  });

  it('rejects another user attempting either choice without streaming', async () => {
    const ambiguous =
      'I am considering a new direction and want to understand how my recent work could fit into it. ' +
      'I have experience across several teams and would like a useful next step.';
    const choice = await choiceFor(ambiguous, 9_200_010);
    for (const callbackData of [choice.jobCallback, choice.questionCallback]) {
      const result = await command(userBId, 9_200_011, '', chatB, callbackData);
      expect(result[0]?.text).toMatch(/not found|not available|expired/i);
    }
    expect(stream).not.toHaveBeenCalled();
  });

  it('expires a choice after 24 hours', async () => {
    const ambiguous =
      'I am considering a new direction and want to understand how my recent work could fit into it. ' +
      'I have experience across several teams and would like a useful next step.';
    const choice = await choiceFor(ambiguous, 9_200_012);
    await database
      .update(tasks)
      .set({ createdAt: new Date(Date.now() - 24 * 60 * 60_000 - 1) })
      .where(eq(tasks.id, choice.taskId));
    const result = await command(
      userAId,
      9_200_013,
      '',
      chatA,
      choice.questionCallback,
    );
    expect(result[0]?.text).toMatch(/expired/i);
    expect(stream).not.toHaveBeenCalled();
  });

  it('retries queued delivery and sends the same choice only once after recovery', async () => {
    const ambiguous =
      'I am considering a new direction and want to understand how my recent work could fit into it. ' +
      'I have experience across several teams and would like a useful next step.';
    const incoming = update(9_200_014, ambiguous);
    const send = vi.fn(async (_chatId: string, _reply: TelegramReply) => {
      if (send.mock.calls.length === 1)
        throw new Error('recorded send failure');
    });
    await receiveTelegramUpdate(incoming, { database, send });
    await drainTelegramUpdates({ database, send, appUrl, stream });
    expect(send).toHaveBeenCalledTimes(1);
    const [delivery] = await database
      .select()
      .from(tasks)
      .where(eq(tasks.idempotencyKey, `telegram:${incoming.updateId}`));
    expect(delivery.status).toBe('running');
    await database
      .update(tasks)
      .set({ updatedAt: new Date(Date.now() - 11 * 60_000 - 1) })
      .where(eq(tasks.id, delivery.id));
    await receiveTelegramUpdate(incoming, { database, send });
    await drainTelegramUpdates({ database, send, appUrl, stream });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1]).toEqual(send.mock.calls[1]?.[1]);
    const { firstReviewFree } = await getFitReviewEligibility(
      userAId,
      database,
    );
    expect(send.mock.calls[1]?.[1].buttons?.map(({ text }) => text)).toEqual([
      firstReviewFree
        ? 'Review this job (first review free)'
        : 'Review this job (1 credit)',
      'It is a question',
    ]);
    expect(stream).not.toHaveBeenCalled();
  });
});
