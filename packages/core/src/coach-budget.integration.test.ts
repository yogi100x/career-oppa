import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { coachMessages, createDatabase, users } from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginCoachMessage,
  failCoachMessage,
  finishCoachMessage,
  getCoachAllowance,
} from './coach';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('shared coach daily allowance', () => {
  const { database, pool } = createDatabase(databaseUrl!);
  let userId: string;
  let parallelUserId: string;
  let staleUserId: string;
  let rollingUserId: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const rows = await database
      .insert(users)
      .values(
        Array.from({ length: 4 }, () => ({
          clerkId: `coach-budget-${randomUUID()}`,
        })),
      )
      .returning({ id: users.id });
    [userId, parallelUserId, staleUserId, rollingUserId] = rows.map(
      ({ id }) => id,
    );
  });

  afterAll(async () => {
    for (const id of [userId, parallelUserId, staleUserId, rollingUserId])
      if (id) await database.delete(users).where(eq(users.id, id));
    await pool.end();
  });

  it('does not count failures or completed replays, and checks the cap before retrying a failure', async () => {
    const failed = await beginCoachMessage(
      userId,
      { message: 'Fail once' },
      'failed-first',
      { database, cap: 1 },
    );
    await failCoachMessage(userId, failed.message.id, database);

    const pending = await beginCoachMessage(
      userId,
      { message: 'Complete once' },
      'successful-first',
      { database, cap: 1 },
    );
    expect(
      (await getCoachAllowance(userId, { database, cap: 1 })).remaining,
    ).toBe(0);
    await finishCoachMessage(
      userId,
      pending.message.id,
      'Recorded successful reply.',
      { promptVersion: 'test', model: 'recorded' },
      database,
    );

    // A late abort/error callback must not release an already saved partial reply.
    expect(
      await failCoachMessage(userId, pending.message.id, database),
    ).toBeNull();

    await expect(
      beginCoachMessage(userId, { message: 'Fail once' }, 'failed-first', {
        database,
        cap: 1,
      }),
    ).rejects.toMatchObject({ code: 'COACH_DAILY_LIMIT', status: 429 });
    const replay = await beginCoachMessage(
      userId,
      { message: 'Complete once' },
      'successful-first',
      { database, cap: 1 },
    );
    expect(replay.reply?.content).toBe('Recorded successful reply.');
    expect(await getCoachAllowance(userId, { database, cap: 1 })).toMatchObject(
      { used: 1, pending: 0, remaining: 0 },
    );
  });

  it('reserves a pending slot across concurrent requests', async () => {
    const results = await Promise.allSettled([
      beginCoachMessage(
        parallelUserId,
        { message: 'First concurrent request' },
        'parallel-a',
        { database, cap: 1 },
      ),
      beginCoachMessage(
        parallelUserId,
        { message: 'Second concurrent request' },
        'parallel-b',
        { database, cap: 1 },
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const blocked = results.find((result) => result.status === 'rejected');
    expect(
      blocked?.status === 'rejected' ? String(blocked.reason) : '',
    ).toMatch(/UTC/);
    expect(
      blocked?.status === 'rejected' ? String(blocked.reason) : '',
    ).toMatch(/paste a job.*Discover.*My roles/i);
    await expect(
      getCoachAllowance(parallelUserId, { database, cap: 1 }),
    ).resolves.toMatchObject({ pending: 1, remaining: 0 });
  });

  it('keeps a slow pending slot reserved beyond the old two-minute cutoff', async () => {
    const pending = await beginCoachMessage(
      staleUserId,
      { message: 'Slow request' },
      'slow',
      { database, cap: 1 },
    );
    const later = new Date(pending.message.updatedAt.getTime() + 3 * 60_000);
    expect(
      await getCoachAllowance(staleUserId, { database, now: later, cap: 1 }),
    ).toMatchObject({ pending: 1, remaining: 0 });
    await expect(
      beginCoachMessage(
        staleUserId,
        { message: 'Another request' },
        'too-soon',
        { database, now: later, cap: 1 },
      ),
    ).rejects.toMatchObject({ code: 'COACH_DAILY_LIMIT' });
    await failCoachMessage(staleUserId, pending.message.id, database);
  });

  it('uses the oldest completed reply for reset rather than an older pending reservation', async () => {
    const now = new Date();
    const completedAt = new Date(now.getTime() - 30_000);
    await database.insert(coachMessages).values({
      userId: rollingUserId,
      role: 'user',
      content: 'Completed question',
      requestKey: 'reset-completed',
      status: 'completed',
      updatedAt: completedAt,
    });
    const pending = await beginCoachMessage(
      rollingUserId,
      { message: 'Still pending' },
      'reset-pending',
      {
        database,
        now: new Date(now.getTime() - 60_000),
      },
    );
    const before = await getCoachAllowance(rollingUserId, { database, now });
    expect(before.resetAt?.getTime()).toBe(
      completedAt.getTime() + 24 * 60 * 60_000,
    );
    await finishCoachMessage(
      rollingUserId,
      pending.message.id,
      'Recorded partial reply.',
      { promptVersion: 'test', model: 'recorded' },
      database,
    );
    expect(
      (await getCoachAllowance(rollingUserId, { database })).resetAt,
    ).toEqual(before.resetAt);
    await database
      .delete(coachMessages)
      .where(eq(coachMessages.userId, rollingUserId));
  });

  it('does not promise a two-minute reset when every counted message is pending', async () => {
    const now = new Date();
    const pending = await beginCoachMessage(
      rollingUserId,
      { message: 'Only pending' },
      'reset-only-pending',
      { database, now },
    );
    const allowance = await getCoachAllowance(rollingUserId, { database, now });
    expect(allowance.resetAt!.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + 24 * 60 * 60_000,
    );
    await failCoachMessage(rollingUserId, pending.message.id, database);
  });

  it('releases stale pending reservations and expires successful messages after a rolling day', async () => {
    const start = new Date('2035-05-06T10:00:00.000Z');
    await beginCoachMessage(
      staleUserId,
      { message: 'Stale pending request' },
      'stale',
      { database, cap: 1, now: start },
    );
    const retried = await beginCoachMessage(
      staleUserId,
      { message: 'Fresh request' },
      'fresh',
      {
        database,
        cap: 1,
        now: new Date(start.getTime() + 11 * 60_000),
      },
    );
    expect(retried.message.status).toBe('pending');

    const old = new Date(Date.now() - 24 * 60 * 60_000 - 1000);
    await database.insert(coachMessages).values({
      userId: rollingUserId,
      role: 'user',
      content: 'Expired successful message',
      requestKey: 'expired-success',
      status: 'completed',
      createdAt: old,
      updatedAt: old,
    });
    expect(
      await getCoachAllowance(rollingUserId, { database, cap: 1 }),
    ).toMatchObject({ used: 0, remaining: 1 });
    await expect(
      beginCoachMessage(
        rollingUserId,
        { message: 'A new day-window message' },
        'new-window',
        { database, cap: 1 },
      ),
    ).resolves.toMatchObject({ message: { status: 'pending' } });
  });
});
