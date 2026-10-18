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
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { streamCoach } from '@career-workspace/adapters/ai/coach';
import { getCoachAllowance } from './coach';
import { handleTelegramCoach } from './telegram-coach';
import type { TelegramUpdate } from './telegram-types';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('Telegram uses the shared coach allowance', () => {
  const { database, pool } = createDatabase(databaseUrl!);
  let userA: string;
  let userB: string;
  const streamed = vi.fn(
    async (options: Parameters<typeof streamCoach>[0]) => ({
      toTextStreamResponse: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              void options
                .onFinish('Recorded coach reply.', {
                  model: 'recorded',
                  promptVersion: 'test',
                })
                .then(() => {
                  controller.enqueue(
                    new TextEncoder().encode('Recorded coach reply.'),
                  );
                  controller.close();
                })
                .catch((error: unknown) => controller.error(error));
            },
          }),
        ),
    }),
  );

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const rows = await database
      .insert(users)
      .values([
        { clerkId: `telegram-budget-a-${randomUUID()}` },
        { clerkId: `telegram-budget-b-${randomUUID()}` },
      ])
      .returning({ id: users.id });
    [userA, userB] = rows.map(({ id }) => id);
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    if (userA) await database.delete(users).where(eq(users.id, userA));
    if (userB) await database.delete(users).where(eq(users.id, userB));
    await pool.end();
  });

  const update = (updateId: number, text: string): TelegramUpdate => ({
    updateId,
    text,
    chatId: `daily-${updateId}`,
    telegramUserId: `daily-${updateId}`,
  });

  it('ignores the retired Telegram-only counter and a delivery replay uses one shared slot', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    streamed.mockClear();
    await database.insert(rateLimits).values({
      userId: userA,
      actionKey: 'telegram_coach_daily',
      count: 50,
    });

    const first = await handleTelegramCoach(
      userA,
      update(81_000_001, 'A Telegram coach question'),
      { database, stream: streamed },
    );
    expect(first.map(({ text }) => text).join('\n')).toContain(
      'Recorded coach reply.',
    );
    expect(streamed).toHaveBeenCalledTimes(1);
    expect(await getCoachAllowance(userA, { database })).toMatchObject({
      used: 1,
      remaining: 19,
    });

    await database
      .update(rateLimits)
      .set({ count: 10 })
      .where(
        and(
          eq(rateLimits.userId, userA),
          eq(rateLimits.actionKey, 'coach_chat'),
        ),
      );
    const replay = await handleTelegramCoach(
      userA,
      update(81_000_001, 'A Telegram coach question'),
      { database, stream: streamed },
    );
    expect(replay.map(({ text }) => text).join('\n')).toContain(
      'Recorded coach reply.',
    );
    expect(
      await database
        .select({ count: rateLimits.count })
        .from(rateLimits)
        .where(
          and(
            eq(rateLimits.userId, userA),
            eq(rateLimits.actionKey, 'coach_chat'),
          ),
        ),
    ).toEqual([{ count: 10 }]);
    expect(streamed).toHaveBeenCalledTimes(1);
    expect(await getCoachAllowance(userA, { database })).toMatchObject({
      used: 1,
      remaining: 19,
    });
    expect(
      await database
        .select({ count: rateLimits.count })
        .from(rateLimits)
        .where(
          and(
            eq(rateLimits.userId, userA),
            eq(rateLimits.actionKey, 'telegram_coach_daily'),
          ),
        ),
    ).toEqual([{ count: 50 }]);
  });

  it('checks missing AI before creating a coach message or allowance use', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    streamed.mockClear();
    const response = await handleTelegramCoach(
      userB,
      update(81_000_002, 'AI is unavailable'),
      { database, stream: streamed },
    );
    expect(response.map(({ text }) => text).join('\n')).toMatch(
      /not connected to AI yet/i,
    );
    expect(streamed).not.toHaveBeenCalled();
    expect(await getCoachAllowance(userB, { database })).toMatchObject({
      used: 0,
      pending: 0,
      remaining: 20,
    });
    expect(
      await database
        .select()
        .from(coachMessages)
        .where(
          and(
            eq(coachMessages.userId, userB),
            eq(coachMessages.requestKey, 'telegram:81000002'),
          ),
        ),
    ).toHaveLength(0);
  });

  it('rejects coach text over 1,000 characters before using a minute slot', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    streamed.mockClear();
    const response = await handleTelegramCoach(
      userB,
      update(81_000_003, 'x'.repeat(1001)),
      { database, stream: streamed },
    );
    expect(response.map(({ text }) => text).join('\n')).toMatch(
      /1,000 characters/i,
    );
    expect(streamed).not.toHaveBeenCalled();
    expect(
      await database
        .select()
        .from(rateLimits)
        .where(
          and(
            eq(rateLimits.userId, userB),
            eq(rateLimits.actionKey, 'coach_chat'),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(coachMessages)
        .where(
          and(
            eq(coachMessages.userId, userB),
            eq(coachMessages.requestKey, 'telegram:81000003'),
          ),
        ),
    ).toHaveLength(0);
  });

  it('shows a reset time and useful alternatives at the shared daily cap', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    streamed.mockClear();
    await database.insert(coachMessages).values(
      Array.from({ length: 20 }, (_, index) => ({
        userId: userB,
        role: 'user',
        content: `Successful message ${index + 1}`,
        requestKey: `daily-cap-${index}`,
        status: 'completed',
      })),
    );
    const response = await handleTelegramCoach(
      userB,
      update(81_000_004, 'One more question'),
      { database, stream: streamed, appUrl: 'https://career.example.test' },
    );
    const text = response.map(({ text: item }) => item).join('\n');
    expect(text).toMatch(/rolling 24-hour coach limit.*UTC/i);
    expect(text).toContain('paste a job for review');
    expect(text).toContain('https://career.example.test/workspace/discover');
    expect(text).toContain('https://career.example.test/workspace?view=roles');
    expect(streamed).not.toHaveBeenCalled();
    expect(await getCoachAllowance(userB, { database })).toMatchObject({
      used: 20,
      remaining: 0,
    });
  });
});
