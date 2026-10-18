import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  closeDatabase,
  createDatabase,
  profileFacts,
  publicJobDiscoverySources,
  users,
} from '@career-workspace/db';
import type { streamCoach } from '@career-workspace/adapters/ai/coach';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { coachToolset } from '@career-workspace/core/coach-toolset';
import { handleTelegramCoach } from '../../../../../../../packages/core/src/telegram-coach';
import type { TelegramUpdate } from '../../../../../../../packages/core/src/telegram-types';
import { POST } from './route';

const mocked = vi.hoisted(() => ({
  userId: '',
  webToolKeys: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../../../lib/api-route', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../lib/api-route')>();
  return {
    ...actual,
    authenticateApi: async () =>
      mocked.userId ? { id: mocked.userId, deletionRequestedAt: null } : null,
  };
});
vi.mock('@career-workspace/adapters/ai/coach', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@career-workspace/adapters/ai/coach')>();
  return {
    ...actual,
    streamCoach: vi.fn(async (options: Parameters<typeof streamCoach>[0]) => {
      mocked.webToolKeys = Object.keys(options.tools).sort();
      await options.onFinish('Recorded web reply for tool parity.', {
        model: 'recorded-test',
        promptVersion: 'test',
      });
      return {
        toTextStreamResponse: () => new Response('Recorded web reply for tool parity.'),
      };
    }),
  };
});

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;
const EXPECTED_TOOL_KEYS = [
  'discoveryMatches',
  'profile',
  'proposeStatus',
  'reminders',
  'role',
  'roles',
  'saveDiscoveredJob',
];

integration('web and Telegram coach tool parity', () => {
  let database: ReturnType<typeof createDatabase>['database'];
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousDiscoveryFlag = process.env.FEATURE_DISCOVERY;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    process.env.DATABASE_URL = databaseUrl;
    process.env.FEATURE_DISCOVERY = 'true';
    process.env.OPENROUTER_API_KEY = 'recorded-test-key';
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
    const [user] = await database
      .insert(users)
      .values({ clerkId: `coach-parity-${randomUUID()}` })
      .returning({ id: users.id });
    userId = user.id;
    await database.insert(profileFacts).values({
      userId,
      kind: 'skill',
      text: 'TypeScript',
      source: 'user',
      status: 'approved',
    });
    await database
      .insert(publicJobDiscoverySources)
      .values({ id: 'greenhouse:figma', provider: 'greenhouse', board: 'figma', company: 'Figma' })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDatabase();
    if (userId) await database.delete(users).where(eq(users.id, userId));
    if (pool) await pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousDiscoveryFlag === undefined) delete process.env.FEATURE_DISCOVERY;
    else process.env.FEATURE_DISCOVERY = previousDiscoveryFlag;
    if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
  });

  it('passes the same real seven-tool factory to both web POST and Telegram', async () => {
    mocked.userId = userId;
    const expected = Object.keys(coachToolset(userId, database)).sort();
    expect(expected).toEqual(EXPECTED_TOOL_KEYS);

    const webResponse = await POST(new Request('http://localhost:3000/api/v1/coach/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `web-${randomUUID()}` },
      body: JSON.stringify({ message: 'Show me my collected jobs' }),
    }));
    expect(webResponse.status).toBe(200);
    expect(await webResponse.text()).toContain('Recorded web reply');
    expect(mocked.webToolKeys).toEqual(expected);

    let telegramToolKeys: string[] = [];
    const recordedTelegramStream: typeof streamCoach = async (options) => {
      telegramToolKeys = Object.keys(options.tools).sort();
      await options.onFinish('Recorded Telegram reply for tool parity.', {
        model: 'recorded-test',
        promptVersion: 'test',
      });
      return { toTextStreamResponse: () => new Response('Recorded Telegram reply for tool parity.') };
    };
    const update: TelegramUpdate = {
      updateId: 782_020_001,
      text: 'Show me my collected jobs',
      chatId: `coach-parity-${userId}`,
      telegramUserId: `coach-parity-${userId}`,
    };
    await handleTelegramCoach(userId, update, { database, stream: recordedTelegramStream });
    expect(telegramToolKeys).toEqual(expected);
  });
});
