import { createHash } from 'node:crypto';
import { and, asc, count, eq, gte, ilike, or, sql } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import {
  events,
  getDatabase,
  ledgerEntries,
  rewardSubmissions,
  users,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import type { LedgerAdjustment, ReviewReward, SubmitReward } from '@career-workspace/contracts';
import { ApiError } from './api';
import { recordEvent } from './events';

export const REWARD_CREDITS = 10;
export const MONTHLY_REWARD_CAP = 3;

function canonicalPostUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new ApiError(400, 'INVALID_URL', 'Enter a valid post URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new ApiError(400, 'INVALID_URL', 'Use a public HTTPS post URL.');
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ['fbclid', 'gclid', 'igshid'].includes(key.toLowerCase()))
      url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

export function hashRewardUrl(url: string) {
  return createHash('sha256').update(canonicalPostUrl(url), 'utf8').digest('hex');
}

export class RewardError extends ApiError {
  constructor(status: number, code: string, message: string) { super(status, code, message); }
}

export async function submitReward(userId: string, input: SubmitReward, database: Database = getDatabase()) {
  const url = canonicalPostUrl(input.url);
  const urlHash = createHash('sha256').update(url, 'utf8').digest('hex');
  return database.transaction(async (tx) => {
    const [record] = await tx.insert(rewardSubmissions).values({
      userId, url, urlHash, disclosureConfirmed: input.disclosureConfirmed,
    }).onConflictDoNothing({ target: rewardSubmissions.urlHash }).returning();
    if (!record) throw new RewardError(409, 'DUPLICATE_SUBMISSION', 'This post URL has already been submitted.');
    await recordEvent({ userId, type: 'reward.submitted', subjectType: 'reward_submission', subjectId: record.id, data: { status: record.status } }, tx);
    return record;
  });
}

export function listRewardSubmissions(userId: string, database: Database = getDatabase()) {
  return database.select({
    ...getTableColumns(rewardSubmissions),
    creditsGranted: sql<number>`coalesce(${ledgerEntries.amount}, 0)::integer`,
  }).from(rewardSubmissions).leftJoin(ledgerEntries, and(
    eq(ledgerEntries.userId, rewardSubmissions.userId),
    eq(ledgerEntries.kind, 'reward'),
    eq(ledgerEntries.idempotencyKey, sql`'reward:' || ${rewardSubmissions.id}::text`),
  )).where(eq(rewardSubmissions.userId, userId)).orderBy(asc(rewardSubmissions.submittedAt));
}

export function listRewardQueue(database: Database = getDatabase()) {
  return database.select({
    id: rewardSubmissions.id, userId: rewardSubmissions.userId, url: rewardSubmissions.url,
    status: rewardSubmissions.status, reason: rewardSubmissions.reason,
    submittedAt: rewardSubmissions.submittedAt, reviewedAt: rewardSubmissions.reviewedAt,
  }).from(rewardSubmissions).where(eq(rewardSubmissions.status, 'pending')).orderBy(asc(rewardSubmissions.submittedAt));
}

async function lockUser(tx: Transaction, userId: string) {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  if (!user) throw new RewardError(404, 'NOT_FOUND', 'User not found.');
}

export async function reviewReward(adminId: string, submissionId: string, input: ReviewReward, database: Database = getDatabase(), now = new Date()) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId))
    throw new RewardError(404, 'NOT_FOUND', 'Submission not found.');
  return database.transaction(async (tx) => {
    const [candidate] = await tx.select({ userId: rewardSubmissions.userId }).from(rewardSubmissions).where(eq(rewardSubmissions.id, submissionId));
    if (!candidate) throw new RewardError(404, 'NOT_FOUND', 'Submission not found.');
    await lockUser(tx, candidate.userId);
    const [submission] = await tx.select().from(rewardSubmissions).where(eq(rewardSubmissions.id, submissionId)).for('update');
    if (!submission) throw new RewardError(404, 'NOT_FOUND', 'Submission not found.');
    if (submission.status !== 'pending') {
      const expectedStatus = input.decision === 'approve' ? 'approved' : 'rejected';
      if (submission.status !== expectedStatus) throw new RewardError(409, 'ALREADY_REVIEWED', 'This submission already has a different decision.');
      const [entry] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `reward:${submission.id}`));
      return { submission, granted: Boolean(entry), credits: entry ? REWARD_CREDITS : 0, replayed: true };
    }
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const reason = input.decision === 'reject' ? input.reason.trim() : null;
    let granted = false;
    if (input.decision === 'approve') {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [monthly] = await tx.select({ value: count() }).from(ledgerEntries).where(and(
        eq(ledgerEntries.userId, submission.userId), eq(ledgerEntries.kind, 'reward'), gte(ledgerEntries.createdAt, monthStart),
      ));
      if (Number(monthly.value) < MONTHLY_REWARD_CAP) {
        const [entry] = await tx.insert(ledgerEntries).values({
          userId: submission.userId, bucket: 'earned', kind: 'reward', amount: REWARD_CREDITS,
          idempotencyKey: `reward:${submission.id}`, createdAt: now,
        }).onConflictDoNothing().returning({ id: ledgerEntries.id });
        granted = Boolean(entry);
      }
    }
    const [updated] = await tx.update(rewardSubmissions).set({ status, reviewerId: adminId, reason, reviewedAt: now }).where(eq(rewardSubmissions.id, submission.id)).returning();
    await recordEvent({
      userId: adminId, actorId: adminId, type: `reward.${status}`, subjectType: 'reward_submission', subjectId: submission.id,
      visibility: 'internal', data: { targetUserId: submission.userId, granted, credits: granted ? REWARD_CREDITS : 0, reason, monthlyCapReached: input.decision === 'approve' && !granted },
    }, tx);
    return { submission: updated, granted, credits: granted ? REWARD_CREDITS : 0, replayed: false };
  });
}

export async function lookupUsers(query: string, database: Database = getDatabase()) {
  const q = query.trim();
  if (q.length < 2 || q.length > 120) throw new RewardError(400, 'INVALID_QUERY', 'Search with 2 to 120 characters.');
  const escaped = q.replace(/[\\%_]/g, '\\$&');
  const uuidQuery = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q);
  return database.select({ id: users.id, clerkId: users.clerkId, role: users.role, createdAt: users.createdAt })
    .from(users).where(uuidQuery ? or(eq(users.id, q), ilike(users.clerkId, `%${escaped}%`)) : ilike(users.clerkId, `%${escaped}%`)).orderBy(asc(users.createdAt)).limit(30);
}

export async function adjustUserLedger(adminId: string, input: LedgerAdjustment, idempotencyKey: string, database: Database = getDatabase(), now = new Date()) {
  const key = idempotencyKey.trim();
  if (!key || key.length > 200) throw new RewardError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide a valid Idempotency-Key.');
  const fullKey = `admin-adjust:${adminId}:${key}`;
  return database.transaction(async (tx) => {
    await lockUser(tx, input.userId);
    const [existing] = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, fullKey));
    if (existing) {
      if (existing.userId !== input.userId || existing.bucket !== input.bucket || existing.amount !== input.amount)
        throw new RewardError(409, 'IDEMPOTENCY_CONFLICT', 'That request key was used for a different adjustment.');
      const [audit] = await tx.select({ data: events.data }).from(events).where(and(
        eq(events.userId, adminId), eq(events.type, 'credits.adjusted'), eq(events.subjectId, existing.id),
      ));
      if ((audit?.data as Record<string, unknown> | undefined)?.reason !== input.reason.trim())
        throw new RewardError(409, 'IDEMPOTENCY_CONFLICT', 'That request key was used for a different adjustment.');
      return { entry: existing, replayed: true };
    }
    const [entry] = await tx.insert(ledgerEntries).values({
      userId: input.userId, bucket: input.bucket, kind: 'adjust', amount: input.amount, idempotencyKey: fullKey, createdAt: now,
    }).onConflictDoNothing().returning();
    if (!entry) throw new RewardError(409, 'IDEMPOTENCY_CONFLICT', 'That request key was already used.');
    await recordEvent({
      userId: adminId, actorId: adminId, type: 'credits.adjusted', subjectType: 'ledger_entry', subjectId: entry.id,
      visibility: 'internal', data: { targetUserId: input.userId, bucket: input.bucket, amount: input.amount, reason: input.reason.trim(), idempotencyKey: key },
    }, tx);
    return { entry, replayed: false };
  });
}
