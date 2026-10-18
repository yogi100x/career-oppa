import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  coachMessages,
  createDatabase,
  rateLimits,
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
import type { streamCoach } from '@career-workspace/adapters/ai/coach';
import { balance } from './credits';
import { beginCoachMessage, finishCoachMessage } from './coach';
import { handleTelegramCommand } from './telegram-commands';
import type { TelegramUpdate } from './telegram-types';
import { drainTelegramUpdates, receiveTelegramUpdate } from './telegram-bot';
import {
  createTelegramLinkCode,
  consumeTelegramLinkCode,
} from './telegram-links';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('Telegram coach', () => {
  const { database, pool } = createDatabase(databaseUrl!);
  let userAId: string;
  let userBId: string;
  const chatA = `${Date.now() + Math.floor(Math.random() * 1_000_000)}`;
  const chatB = `${Number(chatA) + 1}`;
  const appUrl = 'https://career.example.test';
  let recordedReply = 'Recorded coach reply.';
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
        { clerkId: `telegram-coach-a-${randomUUID()}` },
        { clerkId: `telegram-coach-b-${randomUUID()}` },
      ])
      .returning({ id: users.id });
    [userAId, userBId] = rows.map(({ id }) => id);
    for (const [userId, chatId] of [
      [userAId, chatA],
      [userBId, chatB],
    ] as const) {
      const codeUrl = (await createTelegramLinkCode(userId, { database })).url;
      const code = new URL(codeUrl).searchParams.get('start')!;
      expect(
        (await consumeTelegramLinkCode(code, chatId, chatId, { database }))
          .status,
      ).toBe('linked');
    }
  });

  afterAll(async () => {
    await database
      .delete(rateLimits)
      .where(eq(rateLimits.externalSubject, `telegram:${Number(chatB) + 20}`));
    if (userAId) await database.delete(users).where(eq(users.id, userAId));
    if (userBId) await database.delete(users).where(eq(users.id, userBId));
    await pool.end();
  });

  beforeEach(async () => {
    stream.mockClear();
    streamedMessages.length = 0;
    recordedReply = 'Recorded coach reply.';
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    await database
      .delete(rateLimits)
      .where(
        and(
          eq(rateLimits.actionKey, 'coach_chat'),
          eq(rateLimits.userId, userAId),
        ),
      );
    await database
      .delete(rateLimits)
      .where(
        and(
          eq(rateLimits.actionKey, 'coach_chat'),
          eq(rateLimits.userId, userBId),
        ),
      );
  });
  afterEach(() => vi.unstubAllEnvs());

  const update = (
    id: number,
    text: string,
    chatId = chatA,
  ): TelegramUpdate => ({
    updateId: id,
    text,
    chatId,
    telegramUserId: chatId,
  });

  async function command(
    userId: string,
    id: number,
    text: string,
    chatId = chatA,
    options = {},
  ) {
    return handleTelegramCommand(userId, update(id, text, chatId), {
      database,
      appUrl,
      stream,
      ...options,
    });
  }

  it('routes free text to the coach and retains the reply', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const result = await command(
      userAId,
      9_100_001,
      'Help me plan my next step',
    );
    expect(result.map((item) => item.text).join('\n')).toContain(
      'Recorded coach reply.',
    );
    expect(stream).toHaveBeenCalledTimes(1);
    const history = await database
      .select()
      .from(coachMessages)
      .where(eq(coachMessages.userId, userAId))
      .orderBy(coachMessages.createdAt);
    expect(history.map(({ role, content }) => [role, content])).toEqual([
      ['user', 'Help me plan my next step'],
      ['assistant', 'Recorded coach reply.'],
    ]);
  });

  it('splits a long recorded reply into Telegram sized messages', async () => {
    recordedReply = 'r'.repeat(6_100);
    const replies = await command(
      userAId,
      9_100_002,
      'Please give me a long answer',
    );
    expect(replies).toHaveLength(3);
    expect(replies.every((reply) => reply.text.length < 3000)).toBe(true);
    expect(replies.map((reply) => reply.text).join('')).toBe(recordedReply);
  });

  it('keeps markup in a question as untrusted content and returns button-free text', async () => {
    const question = '<b>Help</b> [safe](https://evil.example) *now*';
    recordedReply = question;
    const replies = await command(userAId, 9_100_008, question);
    expect(streamedMessages[0]?.at(-1)).toEqual({
      role: 'user',
      content: question,
    });
    expect(replies).toEqual([{ text: question }]);
    // The SDK wire test verifies this no-button path sets neither parse_mode nor entities.
  });

  it('keeps long job text and URLs on the confirmed review path', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const before = stream.mock.calls.length;
    const job = `A job description with enough details to start the review. ${'Applicants will collaborate with teams and build reliable services. '.repeat(3)}`;
    const pending = await command(userAId, 9_100_011, job);
    expect(pending.map((item) => item.text).join('\n')).toMatch(
      /confirm|review/i,
    );
    const url = await command(
      userAId,
      9_100_012,
      'https://jobs.example.test/role',
    );
    expect(url.map((item) => item.text).join('\n')).toMatch(/confirm|review/i);
    expect(stream).toHaveBeenCalledTimes(before);
  });

  it('deduplicates concurrent handling of one update without spending credits twice', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const before = await balance(userAId, { database });
    const calls = stream.mock.calls.length;
    const send = vi.fn(async (_chatId: string, _reply: { text: string }) => {});
    await Promise.all([
      receiveTelegramUpdate(update(9_100_020, 'Can you help me prepare?'), {
        database,
        send,
      }),
      receiveTelegramUpdate(update(9_100_020, 'Can you help me prepare?'), {
        database,
        send,
      }),
    ]);
    await Promise.all([
      drainTelegramUpdates({ database, send, appUrl, stream }),
      drainTelegramUpdates({ database, send, appUrl, stream }),
    ]);
    await receiveTelegramUpdate(update(9_100_020, 'Can you help me prepare?'), {
      database,
      send,
    });
    await drainTelegramUpdates({ database, send, appUrl, stream });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1].text).toContain('Recorded coach reply.');
    expect(stream).toHaveBeenCalledTimes(calls + 1);
    expect((await balance(userAId, { database })).available).toBe(
      before.available,
    );
    const rows = await database
      .select()
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.userId, userAId),
          eq(coachMessages.requestKey, 'telegram:9100020'),
        ),
      );
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
  });

  it('keeps each Telegram conversation in the matching web coach history', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const webA = await beginCoachMessage(
      userAId,
      { message: 'Web-only history for user A' },
      'web-history-a',
      { database },
    );
    await finishCoachMessage(
      userAId,
      webA.message.id,
      'Web reply for user A',
      { model: 'recorded', promptVersion: 'test' },
      database,
    );
    const webB = await beginCoachMessage(
      userBId,
      { message: 'Web-only history for user B' },
      'web-history-b',
      { database },
    );
    await finishCoachMessage(
      userBId,
      webB.message.id,
      'Web reply for user B',
      { model: 'recorded', promptVersion: 'test' },
      database,
    );
    await command(userAId, 9_100_030, 'A private question for user A');
    await command(userBId, 9_100_031, 'A private question for user B', chatB);
    const a = await database
      .select()
      .from(coachMessages)
      .where(eq(coachMessages.userId, userAId));
    const b = await database
      .select()
      .from(coachMessages)
      .where(eq(coachMessages.userId, userBId));
    expect(a.some((row) => row.content.includes('user B'))).toBe(false);
    expect(b.some((row) => row.content.includes('user A'))).toBe(false);
    expect(
      a.some((row) => row.content === 'A private question for user A'),
    ).toBe(true);
    expect(
      b.some((row) => row.content === 'A private question for user B'),
    ).toBe(true);
    expect(
      streamedMessages[0]?.some((message) =>
        message.content.includes('Web-only history for user A'),
      ),
    ).toBe(true);
    expect(
      streamedMessages[0]?.some((message) =>
        message.content.includes('Web-only history for user B'),
      ),
    ).toBe(false);
    expect(
      streamedMessages[1]?.some((message) =>
        message.content.includes('Web-only history for user B'),
      ),
    ).toBe(true);
    expect(
      streamedMessages[1]?.some((message) =>
        message.content.includes('Web-only history for user A'),
      ),
    ).toBe(false);
  });

  it('shares the web coach minute limit and does not add allowance when blocked', async () => {
    await database
      .insert(rateLimits)
      .values({ userId: userAId, actionKey: 'coach_chat', count: 10 });
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const calls = stream.mock.calls.length;
    const messagesBefore = await database
      .select()
      .from(coachMessages)
      .where(eq(coachMessages.userId, userAId));
    const result = await command(userAId, 9_100_040, 'One more coach message');
    expect(result.map((item) => item.text).join('\n')).toMatch(
      /wait a minute|limit/i,
    );
    expect(stream).toHaveBeenCalledTimes(calls);
    const messagesAfter = await database
      .select()
      .from(coachMessages)
      .where(eq(coachMessages.userId, userAId));
    expect(messagesAfter).toHaveLength(messagesBefore.length);
    await database
      .delete(rateLimits)
      .where(
        and(
          eq(rateLimits.userId, userAId),
          eq(rateLimits.actionKey, 'coach_chat'),
        ),
      );
  });

  it('reports missing AI configuration without adding a coach message or allowance', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const before = await database
      .select()
      .from(rateLimits)
      .where(
        and(
          eq(rateLimits.userId, userAId),
          eq(rateLimits.actionKey, 'coach_chat'),
        ),
      );
    const messagesBefore = await database
      .select()
      .from(coachMessages)
      .where(eq(coachMessages.userId, userAId));
    const calls = stream.mock.calls.length;
    const result = await command(
      userAId,
      9_100_050,
      'Try the coach without a key',
    );
    expect(result.map((item) => item.text).join('\n')).toMatch(
      /not connected to AI yet/i,
    );
    expect(stream).toHaveBeenCalledTimes(calls);
    expect(
      await database
        .select()
        .from(coachMessages)
        .where(eq(coachMessages.userId, userAId)),
    ).toHaveLength(messagesBefore.length);
    expect(
      await database
        .select()
        .from(rateLimits)
        .where(
          and(
            eq(rateLimits.userId, userAId),
            eq(rateLimits.actionKey, 'coach_chat'),
          ),
        ),
    ).toHaveLength(before.length);
  });

  it('uses the same rolling coach cap as the web channel', async () => {
    const [dailyUser] = await database
      .insert(users)
      .values({ clerkId: `telegram-coach-daily-${randomUUID()}` })
      .returning({ id: users.id });
    try {
      await database.insert(coachMessages).values(
        Array.from({ length: 20 }, (_, index) => ({
          userId: dailyUser.id,
          role: 'user',
          content: `Recorded successful message ${index + 1}`,
          requestKey: `daily-seed-${index}`,
          status: 'completed',
        })),
      );
      const calls = stream.mock.calls.length;
      const result = await handleTelegramCommand(
        dailyUser.id,
        update(9_100_055, 'Try one more coach message'),
        { database, appUrl, stream },
      );
      expect(result.map((reply) => reply.text).join('\n')).toMatch(
        /rolling 24-hour coach limit/i,
      );
      expect(stream).toHaveBeenCalledTimes(calls);
    } finally {
      await database.delete(users).where(eq(users.id, dailyUser.id));
    }
  });

  it('marks a failed stream as failed and does not save an assistant response', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const failedStream: typeof streamCoach = async (options) => {
      await options.onError();
      throw new Error('recorded provider failure');
    };
    const replies = await handleTelegramCommand(
      userAId,
      update(9_100_060, 'Please retry this coach request'),
      {
        database,
        appUrl,
        stream: failedStream,
      },
    );
    expect(replies.map((item) => item.text).join('\n')).toMatch(
      /try again|could not answer/i,
    );
    const rows = await database
      .select()
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.userId, userAId),
          eq(coachMessages.requestKey, 'telegram:9100060'),
        ),
      );
    expect(rows.find((row) => row.role === 'user')?.status).toBe('failed');
    expect(rows.some((row) => row.role === 'assistant')).toBe(false);
  });

  it('answers help and unknown commands without starting a coach request; drain forwards typing and stream options', async () => {
    const help = await command(userAId, 9_100_070, '/help');
    expect(help.map((item) => item.text).join('\n')).toMatch(
      /coach|role|profile/i,
    );
    const unknown = await command(userAId, 9_100_071, '/unknown');
    expect(unknown.map((item) => item.text).join('\n')).toMatch(
      /\/roles|job search/i,
    );
    expect(await command(userAId, 9_100_074, '')).toEqual(help);
    expect(stream).not.toHaveBeenCalled();

    const unlinkedSend = vi.fn(
      async (_chatId: string, _reply: { text: string }) => {},
    );
    const unlinkedUpdate = update(
      9_100_073,
      'What should an unlinked account do?',
      `${Number(chatB) + 20}`,
    );
    await receiveTelegramUpdate(unlinkedUpdate, {
      database,
      send: unlinkedSend,
    });
    expect(unlinkedSend).toHaveBeenCalledTimes(1);
    expect(unlinkedSend.mock.calls[0]?.[1].text).toMatch(/connect/i);
    expect(stream).not.toHaveBeenCalled();

    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const typing = vi.fn(async (_chatId: string) => {});
    const send = vi.fn(async () => {});
    await receiveTelegramUpdate(update(9_100_072, 'What should I do next?'), {
      database,
      send,
    });
    await drainTelegramUpdates({ database, send, appUrl, typing, stream });
    expect(typing).toHaveBeenCalledWith(chatA);
    expect(stream).toHaveBeenCalled();
  });
});
