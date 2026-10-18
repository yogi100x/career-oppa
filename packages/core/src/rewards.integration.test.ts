import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from '@career-workspace/db';
import { events, ledgerEntries, users } from '@career-workspace/db';
import { ledgerAdjustmentSchema, reviewRewardSchema, submitRewardSchema } from '@career-workspace/contracts';
import { adjustUserLedger, listRewardQueue, listRewardSubmissions, lookupUsers, reviewReward, submitReward } from './rewards';

const connectionString = process.env.DATABASE_TEST_URL;
if (connectionString && new URL(connectionString).pathname !== '/career_workspace_test')
  throw new Error('DATABASE_TEST_URL must target career_workspace_test.');
const suite = connectionString ? describe : describe.skip;

suite('reward and admin credit workflows', () => {
  const { database, pool } = createDatabase(connectionString ?? 'postgresql://localhost/career_workspace_test');
  const unique = crypto.randomUUID();
  let candidateId = '';
  let secondId = '';
  let adminId = '';

  beforeAll(async () => {
    const records = await database.insert(users).values([
      { clerkId: `reward-candidate-${unique}` },
      { clerkId: `reward-second-${unique}` },
      { clerkId: `reward-admin-${unique}`, role: 'admin' },
    ]).returning({ id: users.id, clerkId: users.clerkId });
    candidateId = records.find((row) => row.clerkId.startsWith('reward-candidate-'))!.id;
    secondId = records.find((row) => row.clerkId.startsWith('reward-second-'))!.id;
    adminId = records.find((row) => row.clerkId.startsWith('reward-admin-'))!.id;
  });

  afterAll(async () => {
    if (candidateId) await database.delete(users).where(eq(users.id, candidateId));
    if (secondId) await database.delete(users).where(eq(users.id, secondId));
    if (adminId) await database.delete(users).where(eq(users.id, adminId));
    await pool.end();
  });

  it('requires disclosure, rejects globally duplicated URLs, and lists submissions only for their owner', async () => {
    expect(submitRewardSchema.safeParse({ url: 'https://example.com/post', disclosureConfirmed: false }).success).toBe(false);
    const created = await submitReward(candidateId, { url: 'https://EXAMPLE.com/post/#thanks', disclosureConfirmed: true }, database);
    expect(created.url).toBe('https://example.com/post');
    await expect(submitReward(secondId, { url: 'https://example.com/post/?utm_source=feed', disclosureConfirmed: true }, database)).rejects.toMatchObject({ code: 'DUPLICATE_SUBMISSION' });
    const listed = await listRewardSubmissions(candidateId, database);
    expect(listed.map((row) => row.id)).toEqual([created.id]);
    expect(listed[0]?.creditsGranted).toBe(0);
    expect(await listRewardSubmissions(secondId, database)).toEqual([]);
  });

  it('grants once under concurrent approval and enforces three earned rewards per user per month', async () => {
    const submissions: Awaited<ReturnType<typeof submitReward>>[] = [];
    for (let index = 0; index < 4; index++)
      submissions.push(await submitReward(candidateId, { url: `https://example.com/posts/${unique}/${index}`, disclosureConfirmed: true }, database));
    expect((await listRewardQueue(database)).some((row) => row.id === submissions[0]!.id)).toBe(true);
    const firstTwo = await Promise.all(submissions.slice(0, 2).map((submission) => reviewReward(adminId, submission.id, { decision: 'approve' }, database)));
    const remaining = [];
    for (const submission of submissions.slice(2))
      remaining.push(await reviewReward(adminId, submission.id, { decision: 'approve' }, database));
    expect([...firstTwo, ...remaining].filter((result) => result.granted)).toHaveLength(3);
    const fourthRetry = await reviewReward(adminId, submissions[3]!.id, { decision: 'approve' }, database);
    expect(fourthRetry.replayed).toBe(true);
    const rewards = await database.select().from(ledgerEntries).where(eq(ledgerEntries.userId, candidateId));
    expect(rewards.filter((entry) => entry.kind === 'reward')).toHaveLength(3);
    expect(new Set(rewards.filter((entry) => entry.kind === 'reward').map((entry) => entry.idempotencyKey)).size).toBe(3);
    const ownedRows = await listRewardSubmissions(candidateId, database);
    const fourth = ownedRows.find((row) => row.id === submissions[3]!.id);
    expect(fourth?.status).toBe('approved');
    expect(fourth?.creditsGranted).toBe(0);
    expect(ownedRows.filter((row) => row.creditsGranted === 10)).toHaveLength(3);
  });

  it('requires rejection reasons and records internal audit events; adjustments are signed and idempotent', async () => {
    const rejected = await submitReward(candidateId, { url: `https://example.com/rejected/${unique}`, disclosureConfirmed: true }, database);
    expect(reviewRewardSchema.safeParse({ decision: 'reject' }).success).toBe(false);
    const reviewed = await reviewReward(adminId, rejected.id, { decision: 'reject', reason: 'Disclosure was not visible.' }, database);
    expect(reviewed.submission.status).toBe('rejected');
    const [event] = await database.select().from(events).where(eq(events.type, 'reward.rejected'));
    expect(event?.visibility).toBe('internal');

    const adjustment = { userId: candidateId, bucket: 'earned' as const, amount: -2, reason: 'Corrected a duplicate grant.' };
    expect(ledgerAdjustmentSchema.safeParse({ ...adjustment, amount: 0 }).success).toBe(false);
    const first = await adjustUserLedger(adminId, adjustment, unique, database);
    const replay = await adjustUserLedger(adminId, adjustment, unique, database);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.entry.id).toBe(first.entry.id);
    await expect(adjustUserLedger(adminId, { ...adjustment, reason: 'Different reason.' }, unique, database)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const found = await lookupUsers(`reward-candidate-${unique}`, database);
    expect(found.map((row) => row.id)).toContain(candidateId);
    const audit = await database.select().from(events).where(eq(events.subjectId, first.entry.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.visibility).toBe('internal');
  });
});
