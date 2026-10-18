import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import {
  creditHolds,
  getDatabase,
  ledgerEntries,
  users,
  type CreditHold,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import { ACTIONS, MONTHLY_ALLOWANCE, type CreditAction } from './catalogue';
import { recordEvent } from '../events';

export { ACTIONS, MONTHLY_ALLOWANCE } from './catalogue';
export type { CreditAction } from './catalogue';
const buckets = ['free', 'earned', 'purchased'] as const;
type Bucket = (typeof buckets)[number];
type Amounts = Record<Bucket, number>;
export type CreditResult = { type: string; id: string };
type Options = { database?: Database; now?: Date; expiresAt?: Date };
export class CreditError extends Error {
  constructor(
    public code:
      | 'NOT_FOUND'
      | 'ACTION_IN_PROGRESS'
      | 'INSUFFICIENT_CREDITS'
      | 'INVALID_INPUT'
      | 'HOLD_NOT_ACTIVE'
      | 'ACCOUNT_DELETION_PENDING',
    message: string,
  ) {
    super(message);
  }
}
function empty(): Amounts {
  return { free: 0, earned: 0, purchased: 0 };
}
async function lock(tx: Transaction, userId: string) {
  const rows = await tx
    .select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!rows.length) throw new CreditError('NOT_FOUND', 'User not found.');
  if (rows[0].deletionRequestedAt)
    throw new CreditError(
      'ACCOUNT_DELETION_PENDING',
      'Account deletion is in progress.',
    );
}
async function totals(tx: Transaction, userId: string, now: Date) {
  const amounts = empty();
  const held = empty();
  const entries = await tx
    .select({
      bucket: ledgerEntries.bucket,
      amount: sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)::integer`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, userId))
    .groupBy(ledgerEntries.bucket);
  for (const entry of entries)
    amounts[entry.bucket as Bucket] = Number(entry.amount);
  const holds = await tx
    .select()
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.userId, userId),
        eq(creditHolds.status, 'reserved'),
        gt(creditHolds.expiresAt, now),
      ),
    );
  for (const hold of holds)
    for (const bucket of buckets) held[bucket] += hold.bucketSplit[bucket] ?? 0;
  const availableBuckets = empty();
  for (const bucket of buckets)
    availableBuckets[bucket] = amounts[bucket] - held[bucket];
  return {
    buckets: amounts,
    held,
    availableBuckets,
    // A negative purchased balance remains visible as debt, but cannot erase
    // separate free or earned credits when deciding what the user may spend.
    available: buckets.reduce(
      (sum, bucket) => sum + Math.max(0, availableBuckets[bucket]),
      0,
    ),
  };
}
async function rollover(tx: Transaction, userId: string, now: Date) {
  const expired = await tx
    .select()
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.userId, userId),
        eq(creditHolds.status, 'reserved'),
        lte(creditHolds.expiresAt, now),
      ),
    );
  await tx
    .update(creditHolds)
    .set({ status: 'expired' })
    .where(
      and(
        eq(creditHolds.userId, userId),
        eq(creditHolds.status, 'reserved'),
        lte(creditHolds.expiresAt, now),
      ),
    );
  const key = `allowance:${userId}:${now.toISOString().slice(0, 7)}`;
  const existing = await tx
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        eq(ledgerEntries.idempotencyKey, key),
      ),
    );
  if (existing.length) {
    for (const hold of expired)
      await expirePriorMonthFree(tx, userId, hold, now);
    return;
  }
  const current = await totals(tx, userId, now);
  const unused = Math.max(0, current.availableBuckets.free);
  if (unused)
    await tx.insert(ledgerEntries).values({
      userId,
      bucket: 'free',
      kind: 'expire',
      amount: -unused,
      idempotencyKey: `expire:${key}`,
      createdAt: now,
    });
  await tx.insert(ledgerEntries).values({
    userId,
    bucket: 'free',
    kind: 'grant',
    amount: MONTHLY_ALLOWANCE,
    idempotencyKey: key,
    createdAt: now,
  });
}
async function expirePriorMonthFree(
  tx: Transaction,
  userId: string,
  hold: CreditHold,
  now: Date,
) {
  const free = hold.bucketSplit.free ?? 0;
  const month = now.toISOString().slice(0, 7);
  if (!free || hold.createdAt.toISOString().slice(0, 7) === month) return;
  const grant = await tx
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        eq(ledgerEntries.idempotencyKey, `allowance:${userId}:${month}`),
      ),
    );
  if (!grant.length) return; // The next rollover expires these with the remaining old allowance.
  await tx
    .insert(ledgerEntries)
    .values({
      userId,
      bucket: 'free',
      kind: 'expire',
      amount: -free,
      idempotencyKey: `expire:hold:${hold.id}`,
      createdAt: now,
    })
    .onConflictDoNothing();
}
export async function balance(userId: string, options: Options = {}) {
  const now = options.now ?? new Date();
  return (options.database ?? getDatabase()).transaction(async (tx) => {
    await lock(tx, userId);
    await rollover(tx, userId, now);
    return totals(tx, userId, now);
  });
}
type Reservation =
  | { status: 'reserved'; hold: CreditHold }
  | { status: 'settled'; result: CreditResult };
export async function reserve(
  userId: string,
  action: CreditAction,
  key: string,
  options: Options = {},
): Promise<Reservation> {
  if (!key.trim() || key.length > 200 || !ACTIONS[action])
    throw new CreditError(
      'INVALID_INPUT',
      'Provide a valid action and request key.',
    );
  const now = options.now ?? new Date();
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + 5 * 60_000);
  if (expiresAt <= now)
    throw new CreditError(
      'INVALID_INPUT',
      'The reservation must expire in the future.',
    );
  const idempotencyKey = `${userId}:${key}`;
  return (options.database ?? getDatabase()).transaction(async (tx) => {
    await lock(tx, userId);
    await rollover(tx, userId, now);
    const [previous] = await tx
      .select()
      .from(creditHolds)
      .where(
        and(
          eq(creditHolds.userId, userId),
          eq(creditHolds.idempotencyKey, idempotencyKey),
          inArray(creditHolds.status, ['reserved', 'settled']),
        ),
      );
    if (previous?.status === 'reserved')
      throw new CreditError(
        'ACTION_IN_PROGRESS',
        'This action is already running.',
      );
    if (previous?.status === 'settled') {
      if (previous.actionKey !== action)
        throw new CreditError(
          'INVALID_INPUT',
          'This request key belongs to a different action.',
        );
      return {
        status: 'settled',
        result: { type: previous.resultType!, id: previous.resultId! },
      };
    }
    const current = await totals(tx, userId, now);
    let remaining = ACTIONS[action].cost as number;
    if (current.available < remaining)
      throw new CreditError(
        'INSUFFICIENT_CREDITS',
        'You do not have enough credits for this action.',
      );
    const split = empty();
    for (const bucket of buckets) {
      split[bucket] = Math.min(
        remaining,
        Math.max(0, current.availableBuckets[bucket]),
      );
      remaining -= split[bucket];
    }
    const [hold] = await tx
      .insert(creditHolds)
      .values({
        userId,
        actionKey: action,
        amount: ACTIONS[action].cost,
        bucketSplit: split,
        status: 'reserved',
        expiresAt,
        idempotencyKey,
        createdAt: now,
      })
      .returning();
    return { status: 'reserved', hold };
  });
}
export async function settle(
  userId: string,
  holdId: string,
  result: CreditResult,
  options: Options = {},
) {
  if (!result.type || !result.id)
    throw new CreditError(
      'INVALID_INPUT',
      'A saved result reference is required.',
    );
  const now = options.now ?? new Date();
  return (options.database ?? getDatabase()).transaction(async (tx) => {
    await lock(tx, userId);
    const [hold] = await tx
      .select()
      .from(creditHolds)
      .where(and(eq(creditHolds.userId, userId), eq(creditHolds.id, holdId)));
    if (!hold) throw new CreditError('NOT_FOUND', 'Reservation not found.');
    if (hold.status === 'settled')
      return {
        charged: true,
        result: { type: hold.resultType!, id: hold.resultId! },
      };
    if (hold.status === 'released')
      throw new CreditError(
        'HOLD_NOT_ACTIVE',
        'This reservation was released.',
      );
    const expired = hold.status === 'expired' || hold.expiresAt <= now;
    if (expired) {
      if (hold.status === 'reserved')
        await expirePriorMonthFree(tx, userId, hold, now);
      await tx
        .update(creditHolds)
        .set({
          status: 'expired',
          resultType: result.type,
          resultId: result.id,
        })
        .where(eq(creditHolds.id, hold.id));
      if (!hold.resultId)
        await recordEvent(
          {
            userId,
            actorId: userId,
            type: 'credit_hold_expired_before_settle',
            subjectType: 'credit_hold',
            subjectId: hold.id,
            visibility: 'internal',
            data: { resultType: result.type, resultId: result.id },
          },
          tx,
        );
      return { charged: false, result };
    }
    for (const bucket of buckets) {
      const amount = hold.bucketSplit[bucket] ?? 0;
      if (amount)
        await tx.insert(ledgerEntries).values({
          userId,
          bucket,
          kind: 'debit',
          amount: -amount,
          idempotencyKey: `debit:${hold.id}:${bucket}`,
          createdAt: now,
        });
    }
    await tx
      .update(creditHolds)
      .set({ status: 'settled', resultType: result.type, resultId: result.id })
      .where(eq(creditHolds.id, hold.id));
    return { charged: true, result };
  });
}
export async function release(
  userId: string,
  holdId: string,
  options: Options = {},
) {
  return (options.database ?? getDatabase()).transaction(async (tx) => {
    await lock(tx, userId);
    const [hold] = await tx
      .select()
      .from(creditHolds)
      .where(and(eq(creditHolds.userId, userId), eq(creditHolds.id, holdId)));
    if (!hold) throw new CreditError('NOT_FOUND', 'Reservation not found.');
    if (hold.status === 'reserved') {
      await expirePriorMonthFree(tx, userId, hold, options.now ?? new Date());
      await tx
        .update(creditHolds)
        .set({ status: 'released' })
        .where(eq(creditHolds.id, hold.id));
    }
  });
}
export async function withCredits(
  userId: string,
  action: CreditAction,
  key: string,
  fn: () => Promise<CreditResult>,
  options: Options = {},
): Promise<CreditResult> {
  const reservation = await reserve(userId, action, key, options);
  if (reservation.status === 'settled') return reservation.result;
  let result: CreditResult;
  try {
    result = await fn();
  } catch (error) {
    await release(userId, reservation.hold.id, options);
    throw error;
  }
  await settle(userId, reservation.hold.id, result, options);
  return result;
}
