import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { coachMessages, createDatabase, users } from '@career-workspace/db';
import { createJob } from './roles';
import { getOpportunityTimeline, updateOpportunityStatus } from './opportunity-status';
import {
  beginCoachMessage,
  coachReaders,
  confirmCoachProposal,
  failCoachMessage,
  finishCoachMessage,
  listCoachMessages,
  listCoachProposals,
} from './coach';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('coach messages and proposals', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkIdA = `coach-a-${randomUUID()}`;
  const clerkIdB = `coach-b-${randomUUID()}`;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test') throw new Error('Use career_workspace_test only.');
    const rows = await database.insert(users).values([{ clerkId: clerkIdA }, { clerkId: clerkIdB }]).returning({ id: users.id });
    [userAId, userBId] = rows.map(({ id }) => id);
  });

  beforeEach(async () => {
    // Each allowance scenario owns its messages and clock. A future-dated
    // reservation from another test must not fill this test's cap.
    await database.delete(coachMessages).where(eq(coachMessages.userId, userAId));
    await database.delete(coachMessages).where(eq(coachMessages.userId, userBId));
  });

  afterAll(async () => {
    await database.delete(users).where(and(eq(users.clerkId, clerkIdA), eq(users.id, userAId)));
    await database.delete(users).where(and(eq(users.clerkId, clerkIdB), eq(users.id, userBId)));
    await pool.end();
  });

  it('keeps retries idempotent and records the assistant reply atomically', async () => {
    const key = randomUUID();
    const begun = await beginCoachMessage(userAId, { message: '  Help me plan this  ' }, key, { database });
    expect(begun).toMatchObject({ message: { role: 'user', content: 'Help me plan this', status: 'pending' }, reply: null, coachId: 'coach' });
    await expect(beginCoachMessage(userAId, { message: 'Help me plan this' }, key, { database })).rejects.toMatchObject({ status: 409, code: 'COACH_MESSAGE_IN_PROGRESS' });
    await expect(beginCoachMessage(userAId, { message: 'Something else' }, key, { database })).rejects.toMatchObject({ status: 409, code: 'REQUEST_KEY_CONFLICT' });
    const finished = await finishCoachMessage(userAId, begun.message.id, 'Here is a useful next step.', { promptVersion: 'coach.v1', model: 'test-model' }, database);
    expect(finished.reply).toMatchObject({ role: 'assistant', replyToId: begun.message.id, status: 'completed', promptVersion: 'coach.v1' });
    const replay = await beginCoachMessage(userAId, { message: 'Help me plan this' }, key, { database });
    expect(replay.reply?.id).toBe(finished.reply.id);
    expect(await listCoachMessages(userAId, database)).toHaveLength(2);
  });

  it('allows retrying a pending request after its recovery window without changing its original time', async () => {
    const createdAt = new Date('2031-02-03T10:00:00.000Z');
    const key = randomUUID();
    const started = await beginCoachMessage(userAId, { message: 'Recover a stalled answer' }, key, { database, now: createdAt });
    await expect(beginCoachMessage(userAId, { message: 'Recover a stalled answer' }, key, { database, now: new Date(createdAt.getTime() + 60_000) })).rejects.toMatchObject({ status: 409, code: 'COACH_MESSAGE_IN_PROGRESS' });
    const recovered = await beginCoachMessage(userAId, { message: 'Recover a stalled answer' }, key, { database, now: new Date(createdAt.getTime() + 11 * 60_000) });
    expect(recovered.message.id).toBe(started.message.id);
    expect(recovered.message.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(recovered.message.updatedAt.toISOString()).toBe(new Date(createdAt.getTime() + 11 * 60_000).toISOString());
  });

  it('reuses failed rows, enforces the daily cap under concurrent requests, and scopes records by user', async () => {
    const now = new Date();
    const first = await beginCoachMessage(userAId, { message: 'First attempt' }, randomUUID(), { database, cap: 2, now });
    expect(await failCoachMessage(userBId, first.message.id, database)).toBeNull();
    expect((await failCoachMessage(userAId, first.message.id, database))?.status).toBe('failed');
    const retried = await beginCoachMessage(userAId, { message: 'First attempt' }, first.message.requestKey!, { database, cap: 2, now: new Date(now.getTime() + 1000) });
    expect(retried.message.id).toBe(first.message.id);
    await finishCoachMessage(userAId, first.message.id, 'Recovered reply', { promptVersion: 'coach.v1', model: 'test-model' }, database);
    const concurrent = await Promise.allSettled([
      beginCoachMessage(userAId, { message: 'Second message' }, randomUUID(), { database, cap: 2, now }),
      beginCoachMessage(userAId, { message: 'Third message' }, randomUUID(), { database, cap: 2, now }),
    ]);
    expect(concurrent.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((item) => item.status === 'rejected')).toHaveLength(1);
    await expect(listCoachMessages(userBId, database)).resolves.toHaveLength(0);
    await expect(beginCoachMessage(userBId, { message: 'Try the other user’s opportunity', opportunityId: randomUUID() }, randomUUID(), { database })).rejects.toMatchObject({ status: 404 });
    const all = await database.select().from(coachMessages).where(eq(coachMessages.userId, userAId));
    expect(all.filter((item) => item.role === 'user')).toHaveLength(2);
  });

  it('only exposes owned reader data and applies a proposal after explicit confirmation once', async () => {
    const { opportunity } = await createJob(userAId, { title: 'Coach role', company: 'Example', text: 'A role description for a coach status proposal test. '.repeat(4) }, { database });
    const readersA = coachReaders(userAId, database);
    await expect(coachReaders(userBId, database).role(opportunity.id)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const proposal = await readersA.proposeStatus(opportunity.id, 'reviewed', 'The role is a good fit to consider.');
    expect(proposal.data).toEqual({ from: 'saved', to: 'reviewed', reason: 'The role is a good fit to consider.' });
    expect((await readersA.role(opportunity.id)).opportunity.status).toBe('saved');
    await expect(listCoachProposals(userBId, database)).resolves.toHaveLength(0);
    await expect(confirmCoachProposal(userBId, proposal.id, database)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const confirmed = await confirmCoachProposal(userAId, proposal.id, database);
    expect(confirmed).toMatchObject({ alreadyConfirmed: false, opportunity: { status: 'reviewed' } });
    const replay = await confirmCoachProposal(userAId, proposal.id, database);
    expect(replay.alreadyConfirmed).toBe(true);
    const timeline = await getOpportunityTimeline(userAId, opportunity.id, database);
    expect(timeline.filter((event) => event.type === 'opportunity.status_changed')).toHaveLength(1);
  });

  it('rejects a proposal when the role status changed before confirmation', async () => {
    const { opportunity } = await createJob(userAId, { title: 'Changing role', company: 'Example', text: 'A role description used to test stale status proposals. '.repeat(4) }, { database });
    const proposal = await coachReaders(userAId, database).proposeStatus(opportunity.id, 'applied', 'I have decided to apply.');
    await updateOpportunityStatus(userAId, opportunity.id, 'reviewed', database);
    await expect(confirmCoachProposal(userAId, proposal.id, database)).rejects.toMatchObject({ status: 409, code: 'STALE_PROPOSAL' });
    expect((await listCoachProposals(userAId, database)).find((item) => item.id === proposal.id)?.confirmedAt).toBeNull();
  });
});
