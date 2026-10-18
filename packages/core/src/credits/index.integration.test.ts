import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, users, ledgerEntries } from '@career-workspace/db';
import { eq } from 'drizzle-orm';
import { balance, reserve, release, settle, withCredits } from './index';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('credit accounting in Postgres', () => {
  const { database, pool } = createDatabase(url!);
  const ids: string[] = [];
  async function candidate() {
    const [user] = await database
      .insert(users)
      .values({ clerkId: `credits-${randomUUID()}` })
      .returning();
    ids.push(user.id);
    return user.id;
  }
  beforeAll(() => {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
  });
  afterAll(async () => {
    for (const id of ids) await database.delete(users).where(eq(users.id, id));
    await pool.end();
  });
  it('20 parallel reserves cannot spend more than the allowance', async () => {
    const userId = await candidate();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        reserve(userId, 'tailor_cv', `parallel-${i}`, { database }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(10);
    expect((await balance(userId, { database })).available).toBe(0);
  });
  it('blocks a running retry, replays a settled result, and lets released work retry', async () => {
    const userId = await candidate();
    const first = await reserve(userId, 'fit_review', 'same', { database });
    if (first.status !== 'reserved') throw new Error('Expected reservation.');
    await expect(
      reserve(userId, 'fit_review', 'same', { database }),
    ).rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS' });
    await settle(
      userId,
      first.hold.id,
      { type: 'fit_review', id: 'result' },
      { database },
    );
    expect(
      await reserve(userId, 'fit_review', 'same', { database }),
    ).toMatchObject({
      status: 'settled',
      result: { type: 'fit_review', id: 'result' },
    });
    expect((await balance(userId, { database })).available).toBe(29);
    const retry = await reserve(userId, 'tailor_cv', 'retry', { database });
    if (retry.status !== 'reserved') throw new Error('Expected reservation.');
    await release(userId, retry.hold.id, { database });
    expect(
      await reserve(userId, 'tailor_cv', 'retry', { database }),
    ).toMatchObject({ status: 'reserved' });
  });
  it('an expired hold stops reducing balance and its late result is not charged', async () => {
    const userId = await candidate();
    const now = new Date('2026-10-06T10:00:00Z');
    const first = await reserve(userId, 'tailor_cv', 'expires', {
      database,
      now,
      expiresAt: new Date(now.getTime() + 1000),
    });
    if (first.status !== 'reserved') throw new Error('Expected reservation.');
    const later = new Date(now.getTime() + 2000);
    expect((await balance(userId, { database, now: later })).available).toBe(
      30,
    );
    expect(
      await settle(
        userId,
        first.hold.id,
        { type: 'resume', id: 'late' },
        { database, now: later },
      ),
    ).toMatchObject({ charged: false });
    expect((await balance(userId, { database, now: later })).available).toBe(
      30,
    );
  });
  it('rolls the month over while preserving held free credits', async () => {
    const userId = await candidate();
    const january = new Date('2026-01-31T23:59:00Z');
    const february = new Date('2026-02-01T00:00:01Z');
    const held = await reserve(userId, 'tailor_cv', 'month', {
      database,
      now: january,
      expiresAt: new Date('2026-02-02T00:00:00Z'),
    });
    if (held.status !== 'reserved') throw new Error('Expected reservation.');
    expect((await balance(userId, { database, now: february })).available).toBe(
      30,
    );
    await settle(
      userId,
      held.hold.id,
      { type: 'resume', id: 'month-result' },
      { database, now: february },
    );
    expect(
      (await balance(userId, { database, now: february })).buckets.free,
    ).toBe(30);
  });
  it('grants the allowance before the first paid action of the month', async () => {
    const userId = await candidate();
    await reserve(userId, 'fit_review', 'first', { database });
    expect((await balance(userId, { database })).available).toBe(29);
  });
  it('expires last month’s held credits when a hold is released or expires after rollover', async () => {
    for (const outcome of ['release', 'expire']) {
      const userId = await candidate();
      const january = new Date('2026-01-31T23:59:00Z');
      const february = new Date('2026-02-01T00:00:01Z');
      const hold = await reserve(userId, 'tailor_cv', outcome, {
        database,
        now: january,
        expiresAt: new Date('2026-02-01T01:00:00Z'),
      });
      if (hold.status !== 'reserved') throw new Error('Expected reservation.');
      expect(
        (await balance(userId, { database, now: february })).available,
      ).toBe(30);
      if (outcome === 'release')
        await release(userId, hold.hold.id, { database, now: february });
      const later = new Date('2026-02-01T02:00:00Z');
      expect((await balance(userId, { database, now: later })).available).toBe(
        30,
      );
    }
  });
  it('writes one debit per used bucket and does not charge a failed action', async () => {
    const userId = await candidate();
    await balance(userId, { database });
    await database.insert(ledgerEntries).values([
      { userId, amount: -29, bucket: 'free', kind: 'adjust' },
      { userId, amount: 1, bucket: 'earned', kind: 'reward' },
      { userId, amount: 1, bucket: 'purchased', kind: 'purchase' },
    ]);
    const held = await reserve(userId, 'tailor_cv', 'split', { database });
    if (held.status !== 'reserved') throw new Error('Expected reservation.');
    expect(held.hold.bucketSplit).toEqual({ free: 1, earned: 1, purchased: 1 });
    await settle(
      userId,
      held.hold.id,
      { type: 'resume', id: 'split' },
      { database },
    );
    const entries = await database
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, userId));
    expect(entries.filter((entry) => entry.kind === 'debit')).toHaveLength(3);
    const another = await candidate();
    await expect(
      withCredits(
        another,
        'tailor_cv',
        'fails',
        async () => {
          throw new Error('Provider failed');
        },
        { database },
      ),
    ).rejects.toThrow('Provider failed');
    expect((await balance(another, { database })).available).toBe(30);
  });
  it('retries a released wrapper call and blocks pending retries without a second action or debit', async () => {
    const userId = await candidate();
    let calls = 0;
    await expect(withCredits(userId, 'tailor_cv', 'wrapper-retry', async () => {
      calls += 1;
      throw new Error('Recorded provider failure');
    }, { database })).rejects.toThrow('Recorded provider failure');
    expect((await balance(userId, { database })).available).toBe(30);
    let unblock!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const pending = withCredits(userId, 'tailor_cv', 'wrapper-retry', async () => {
      calls += 1;
      started();
      await gate;
      return { type: 'resume', id: 'saved-result' };
    }, { database });
    await entered;
    try {
      await expect(withCredits(userId, 'tailor_cv', 'wrapper-retry', async () => {
        calls += 1;
        return { type: 'resume', id: 'duplicate' };
      }, { database })).rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS' });
    } finally { unblock(); }
    expect(await pending).toEqual({ type: 'resume', id: 'saved-result' });
    expect(await withCredits(userId, 'tailor_cv', 'wrapper-retry', async () => {
      calls += 1;
      return { type: 'resume', id: 'duplicate' };
    }, { database })).toEqual({ type: 'resume', id: 'saved-result' });
    expect(calls).toBe(2);
    expect((await balance(userId, { database })).available).toBe(27);
  });

});
