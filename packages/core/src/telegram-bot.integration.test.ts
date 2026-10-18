import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDatabase, rateLimits, tasks, users } from '@career-workspace/db';
import {
  consumeTelegramLinkCode,
  createTelegramLinkCode,
  disconnectTelegram,
} from './telegram-links';
import {
  drainTelegramUpdates,
  receiveTelegramUpdate,
  type TelegramUpdate,
  type TelegramReply,
} from './telegram-bot';

const url = process.env.DATABASE_TEST_URL;
(url ? describe : describe.skip)('durable Telegram intake', () => {
  const { database, pool } = createDatabase(url!);
  let userId: string;
  const identity = `${Date.now() + Math.floor(Math.random() * 1_000_000)}`;
  const send = vi.fn(async () => {});
  const update = (id: number, text = '/credits'): TelegramUpdate => ({
    updateId: id,
    text,
    chatId: identity,
    telegramUserId: identity,
  });
  const base = Date.now() + Math.floor(Math.random() * 1_000_000);
  const unlinkedIdentities = [100, 101, 102, 103].map(
    (offset) => `${Number(identity) + offset}`,
  );
  beforeAll(async () => {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Test database only');
    const [user] = await database
      .insert(users)
      .values({ clerkId: `telegram-intake-${randomUUID()}` })
      .returning();
    userId = user.id;
  });
  afterAll(async () => {
    await database.delete(rateLimits).where(
      and(
        eq(rateLimits.actionKey, 'telegram_unlinked_reply'),
        inArray(
          rateLimits.externalSubject,
          [identity, ...unlinkedIdentities].map((id) => `telegram:${id}`),
        ),
      ),
    );
    await database.delete(users).where(eq(users.id, userId));
    await pool.end();
  });
  it('rejects non-private identities and gives unlinked users only the connect link', async () => {
    expect(
      await receiveTelegramUpdate(
        { ...update(base), chatId: '-100' },
        { database, send },
      ),
    ).toEqual({ queued: false });
    expect(send).not.toHaveBeenCalled();
    await receiveTelegramUpdate(update(base), { database, send });
    expect(send.mock.calls).toHaveLength(1);
  });
  it('caps unlinked replies per account, resets after an hour, and still permits linking', async () => {
    const blockedIdentity = `${Number(identity) + 100}`;
    const otherIdentity = `${Number(identity) + 101}`;
    const capture = vi.fn(async (_chatId: string, _reply: TelegramReply) => {});
    const makeUpdate = (id: number, account: string, text = 'hello') => ({
      updateId: id,
      text,
      chatId: account,
      telegramUserId: account,
    });
    for (let index = 0; index < 5; index++) {
      await receiveTelegramUpdate(
        makeUpdate(base + 100 + index, blockedIdentity),
        { database, send: capture },
      );
      await receiveTelegramUpdate(
        makeUpdate(base + 200 + index, otherIdentity),
        { database, send: capture },
      );
    }
    expect(capture).toHaveBeenCalledTimes(10);
    await receiveTelegramUpdate(makeUpdate(base + 105, blockedIdentity), {
      database,
      send: capture,
    });
    await receiveTelegramUpdate(
      makeUpdate(base + 106, blockedIdentity, '/start'),
      { database, send: capture },
    );
    expect(capture).toHaveBeenCalledTimes(10);

    const [limit] = await database
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.externalSubject, `telegram:${blockedIdentity}`));
    expect(limit.userId).toBeNull();
    await database
      .update(rateLimits)
      .set({ windowStart: new Date(Date.now() - 60 * 60_000 - 1) })
      .where(eq(rateLimits.id, limit.id));
    await receiveTelegramUpdate(makeUpdate(base + 107, blockedIdentity), {
      database,
      send: capture,
    });
    expect(capture).toHaveBeenCalledTimes(11);
    for (let index = 0; index < 4; index++)
      await receiveTelegramUpdate(
        makeUpdate(base + 120 + index, blockedIdentity),
        { database, send: capture },
      );
    expect(capture).toHaveBeenCalledTimes(15);
    await receiveTelegramUpdate(makeUpdate(base + 124, blockedIdentity), {
      database,
      send: capture,
    });
    expect(capture).toHaveBeenCalledTimes(15);

    const [linkUser] = await database
      .insert(users)
      .values({ clerkId: `telegram-intake-link-${randomUUID()}` })
      .returning();
    try {
      const link = await createTelegramLinkCode(linkUser.id, { database });
      const code = new URL(link.url).searchParams.get('start')!;
      await receiveTelegramUpdate(
        makeUpdate(base + 108, blockedIdentity, `/start ${code}`),
        { database, send: capture },
      );
      expect(capture).toHaveBeenCalledTimes(16);
      expect(capture.mock.calls.at(-1)?.[1].text).toBe(
        'Send me a job link for a fit review.\nOr ask me for matching roles.',
      );
    } finally {
      await database.delete(users).where(eq(users.id, linkUser.id));
    }

    const concurrentIdentity = `${Number(identity) + 102}`;
    const beforeConcurrent = capture.mock.calls.length;
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        receiveTelegramUpdate(
          makeUpdate(base + 300 + index, concurrentIdentity),
          { database, send: capture },
        ),
      ),
    );
    expect(capture.mock.calls.length - beforeConcurrent).toBe(5);

    const invalidStartIdentity = `${Number(identity) + 103}`;
    const beforeInvalidStarts = capture.mock.calls.length;
    for (let index = 0; index < 5; index++)
      await receiveTelegramUpdate(
        makeUpdate(base + 400 + index, invalidStartIdentity, '/start invalid'),
        { database, send: capture },
      );
    await receiveTelegramUpdate(
      makeUpdate(base + 405, invalidStartIdentity, '/start invalid'),
      { database, send: capture },
    );
    expect(capture.mock.calls.length - beforeInvalidStarts).toBe(5);
  });
  it('does not claim a wrong-user or reused link connected this chat', async () => {
    const [other] = await database
      .insert(users)
      .values({ clerkId: `telegram-intake-other-${randomUUID()}` })
      .returning();
    const linkedIdentity = `${Number(identity) + 7}`;
    const freshIdentity = `${Number(identity) + 8}`;
    try {
      const own = await createTelegramLinkCode(other.id, { database });
      const ownCode = new URL(own.url).searchParams.get('start')!;
      expect(
        (
          await consumeTelegramLinkCode(
            ownCode,
            linkedIdentity,
            linkedIdentity,
            { database },
          )
        ).status,
      ).toBe('linked');
      const sent: string[] = [];
      const capture = async (_chat: string, reply: { text: string }) => {
        sent.push(reply.text);
      };
      // A different user's code opened from an already linked Telegram account.
      const foreign = await createTelegramLinkCode(userId, { database });
      const foreignCode = new URL(foreign.url).searchParams.get('start')!;
      await receiveTelegramUpdate(
        {
          updateId: base + 50,
          text: `/start ${foreignCode}`,
          chatId: linkedIdentity,
          telegramUserId: linkedIdentity,
        },
        { database, send: capture },
      );
      // The first code again, from an unlinked Telegram account.
      await receiveTelegramUpdate(
        {
          updateId: base + 51,
          text: `/start ${ownCode}`,
          chatId: freshIdentity,
          telegramUserId: freshIdentity,
        },
        { database, send: capture },
      );
      expect(sent[0]).toMatch(/already connected/);
      expect(sent[0]).not.toMatch(/^Connected/);
      expect(sent[1]).toMatch(/already been used/);
    } finally {
      await database.delete(users).where(eq(users.id, other.id));
    }
  });
  it('links without storing a raw one-time code in tasks', async () => {
    const { url: link } = await createTelegramLinkCode(userId, { database });
    const code = new URL(link).searchParams.get('start')!;
    await receiveTelegramUpdate(
      update(base + 1, `/start@CareerOppaBot ${code}`),
      {
        database,
        send,
      },
    );
    const stored = await database
      .select()
      .from(tasks)
      .where(eq(tasks.userId, userId));
    expect(JSON.stringify(stored)).not.toContain(code);
  });
  it('accepts duplicate updates once and recovers a failed delivery without rerunning the handler', async () => {
    await Promise.all(
      [1, 2].map(() =>
        receiveTelegramUpdate(update(base + 2), { database, send }),
      ),
    );
    const handle = vi.fn(async () => [{ text: 'Balance available' }]);
    const failedSend = vi.fn(async () => {
      throw new Error('transport failed');
    });
    await drainTelegramUpdates({ database, send: failedSend, handle });
    await database
      .update(tasks)
      .set({ updatedAt: new Date(0) })
      .where(and(eq(tasks.userId, userId), eq(tasks.kind, 'telegram_update')));
    await drainTelegramUpdates({ database, send, handle });
    expect(handle).toHaveBeenCalledTimes(1);
    const stored = await database
      .select()
      .from(tasks)
      .where(eq(tasks.idempotencyKey, `telegram:${base + 2}`));
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('succeeded');
    expect(stored[0].input).toEqual({});
  });
  it('waits for the review reservation before recovering interrupted incoming work', async () => {
    await receiveTelegramUpdate(update(base + 4), { database, send });
    const condition = eq(tasks.idempotencyKey, `telegram:${base + 4}`);
    await database
      .update(tasks)
      .set({
        status: 'running',
        attempts: 1,
        updatedAt: new Date(Date.now() - 6 * 60_000),
      })
      .where(condition);
    const handle = vi.fn(async () => [{ text: 'Recovered' }]);
    await drainTelegramUpdates({ database, send, handle });
    expect(handle).not.toHaveBeenCalled();
    await database
      .update(tasks)
      .set({ updatedAt: new Date(Date.now() - 12 * 60_000) })
      .where(condition);
    await drainTelegramUpdates({ database, send, handle });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('does not send queued messages after disconnect, including after a new link', async () => {
    await receiveTelegramUpdate(update(base + 3), { database, send });
    await disconnectTelegram(userId, database);
    const { url: link } = await createTelegramLinkCode(userId, { database });
    await consumeTelegramLinkCode(
      new URL(link).searchParams.get('start')!,
      identity,
      identity,
      { database },
    );
    send.mockClear();
    await drainTelegramUpdates({ database, send });
    expect(send).not.toHaveBeenCalled();
  });
});
