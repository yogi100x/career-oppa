import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDatabase,
  telegramLinkCodes,
  telegramLinks,
  users,
} from '@career-workspace/db';
import {
  consumeTelegramLinkCode,
  createTelegramLinkCode,
  disconnectTelegram,
  getTelegramLink,
  getUserForTelegram,
} from './telegram-links';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('Telegram account links', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkId = `telegram-${randomUUID()}`;
  const otherClerkId = `telegram-other-${randomUUID()}`;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const created = await database
      .insert(users)
      .values([{ clerkId }, { clerkId: otherClerkId }])
      .returning({ id: users.id });
    [userId, otherUserId] = created.map((user) => user.id);
  });

  afterAll(async () => {
    await database.delete(users).where(eq(users.clerkId, clerkId));
    await database.delete(users).where(eq(users.clerkId, otherClerkId));
    await pool.end();
  });

  function codeFrom(url: string) {
    return new URL(url).searchParams.get('start')!;
  }

  it('stores only a hash and consumes a code once for one account', async () => {
    const { url, expiresAt } = await createTelegramLinkCode(userId, {
      database,
      now: () => new Date('2026-10-11T10:00:00Z'),
    });
    const code = codeFrom(url);
    expect(url).toMatch(/^https:\/\/t\.me\/CareerOppaBot\?start=/);
    expect(expiresAt.toISOString()).toBe('2026-10-11T10:10:00.000Z');
    const stored = await database.select().from(telegramLinkCodes);
    expect(stored.some((row) => row.codeHash === code)).toBe(false);

    const [first, second] = await Promise.all([
      consumeTelegramLinkCode(code, '1001', '1001', {
        database,
        now: () => new Date('2026-10-11T10:01:00Z'),
      }),
      consumeTelegramLinkCode(code, '1001', '1001', {
        database,
        now: () => new Date('2026-10-11T10:01:00Z'),
      }),
    ]);
    expect(
      [first.status, second.status].filter((status) => status === 'linked'),
    ).toHaveLength(1);
    expect([first.status, second.status]).toContain('already_used');
    expect(await getTelegramLink(userId, database)).toMatchObject({
      telegramUserId: '1001',
      chatId: '1001',
      remindersEnabled: true,
    });
  });

  it('rejects expired codes and does not let another signed-in user read the link', async () => {
    const expired = await createTelegramLinkCode(otherUserId, {
      database,
      now: () => new Date('2026-10-11T10:00:00Z'),
    });
    expect(
      (
        await consumeTelegramLinkCode(codeFrom(expired.url), '1002', '1002', {
          database,
          now: () => new Date('2026-10-11T10:10:00Z'),
        })
      ).status,
    ).toBe('expired');
    expect(await getTelegramLink(otherUserId, database)).toBeNull();
  });

  it('rejects non-private chat identities', async () => {
    const pending = await createTelegramLinkCode(otherUserId, { database });
    expect(
      (
        await consumeTelegramLinkCode(codeFrom(pending.url), '1004', '-1004', {
          database,
        })
      ).status,
    ).toBe('invalid');
    expect(await getTelegramLink(otherUserId, database)).toBeNull();
  });

  it('refuses linking an already linked account or a Telegram identity owned by another user', async () => {
    const userCode = await createTelegramLinkCode(userId, { database });
    expect(
      (
        await consumeTelegramLinkCode(codeFrom(userCode.url), '1003', '1003', {
          database,
        })
      ).status,
    ).toBe('already_linked');

    const otherCode = await createTelegramLinkCode(otherUserId, { database });
    expect(
      (
        await consumeTelegramLinkCode(codeFrom(otherCode.url), '1001', '1001', {
          database,
        })
      ).status,
    ).toBe('identity_conflict');
  });

  it('requires the same private chat and refuses users pending account deletion', async () => {
    expect(await getUserForTelegram('1001', '9999', database)).toBeNull();
    expect((await getUserForTelegram('1001', '1001', database))?.id).toBe(
      userId,
    );
    await database
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, userId));
    expect(await getUserForTelegram('1001', '1001', database)).toBeNull();
    await database
      .update(users)
      .set({ deletionRequestedAt: null })
      .where(eq(users.id, userId));
  });

  it('disconnects and account deletion remove links and pending codes', async () => {
    await createTelegramLinkCode(otherUserId, { database });
    await disconnectTelegram(otherUserId, database);
    expect(
      await database
        .select()
        .from(telegramLinkCodes)
        .where(eq(telegramLinkCodes.userId, otherUserId)),
    ).toHaveLength(0);
    const pending = await createTelegramLinkCode(otherUserId, { database });
    expect(pending.url).toContain('start=');
    await database.delete(users).where(eq(users.id, otherUserId));
    expect(
      await database
        .select()
        .from(telegramLinks)
        .where(eq(telegramLinks.userId, otherUserId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(telegramLinkCodes)
        .where(eq(telegramLinkCodes.userId, otherUserId)),
    ).toHaveLength(0);

    await database.delete(users).where(eq(users.id, userId));
    expect(
      await database
        .select()
        .from(telegramLinks)
        .where(eq(telegramLinks.userId, userId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(telegramLinkCodes)
        .where(eq(telegramLinkCodes.userId, userId)),
    ).toHaveLength(0);
  });
});
