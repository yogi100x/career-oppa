import { and, asc, eq, sql } from 'drizzle-orm';
import {
  getDatabase,
  ledgerEntries,
  paymentEvents,
  paymentRefunds,
  payments,
  users,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import type { CreditPack, CreditPackId } from '@career-workspace/contracts';
import { recordEvent } from './events';

const packs: CreditPack[] = [
  { id: 'starter', name: 'Starter', priceUsdCents: 500, credits: 100 },
  { id: 'job_hunt', name: 'Job hunt', priceUsdCents: 1200, credits: 300 },
  { id: 'full_season', name: 'Full season', priceUsdCents: 2500, credits: 750 },
];
const packCredits: Record<CreditPackId, number> = {
  starter: 100,
  job_hunt: 300,
  full_season: 750,
};

export function listCreditPacks(): CreditPack[] {
  return packs.map((pack) => ({ ...pack }));
}

export type VerifiedPayment = {
  paymentId: string;
  userId: string;
  packId: CreditPackId;
  productId: string;
  quantity: number;
  totalAmountMinor: number;
  currency: string;
};
export type VerifiedRefund = {
  refundId: string;
  paymentId: string;
  isPartial: boolean;
  status: 'succeeded' | 'pending' | 'failed' | 'review';
  amountMinor?: number;
  currency?: string;
};
export type RecordPaymentEventInput = {
  webhookId: string;
  type: string;
  payload: unknown;
  payment?: VerifiedPayment;
  refund?: VerifiedRefund;
};
export type RecordPaymentEventResult = {
  duplicate: boolean;
  action: 'purchase_granted' | 'refund_debited' | 'manual_review' | 'logged';
};

export class PaymentEventError extends Error {
  constructor(
    public code: 'INVALID_EVENT' | 'USER_NOT_FOUND' | 'PAYMENT_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

function validate(input: RecordPaymentEventInput) {
  if (!input.webhookId.trim() || input.webhookId.length > 200 || !input.type.trim())
    throw new PaymentEventError('INVALID_EVENT', 'A valid webhook ID and type are required.');
  if (input.payment) {
    const payment = input.payment;
    if (
      input.type !== 'payment.succeeded' ||
      !payment.paymentId.trim() ||
      !payment.userId.trim() ||
      !payment.productId.trim() ||
      payment.quantity !== 1 ||
      !Number.isSafeInteger(payment.totalAmountMinor) ||
      payment.totalAmountMinor < 0 ||
      !/^[A-Z]{3}$/.test(payment.currency) ||
      !Object.hasOwn(packCredits, payment.packId)
    )
      throw new PaymentEventError('INVALID_EVENT', 'Payment does not match a supported credit pack.');
  }
  if (input.refund) {
    const refund = input.refund;
    if (
      input.type !== 'refund.succeeded' ||
      !refund.refundId.trim() ||
      !refund.paymentId.trim() ||
      (refund.amountMinor !== undefined &&
        (!Number.isSafeInteger(refund.amountMinor) || refund.amountMinor < 0))
    )
      throw new PaymentEventError('INVALID_EVENT', 'Refund notification is invalid.');
  }
  if (input.payment && input.refund)
    throw new PaymentEventError('INVALID_EVENT', 'A notification cannot be both a payment and a refund.');
}

async function lockUser(tx: Transaction, userId: string) {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  if (!user) throw new PaymentEventError('USER_NOT_FOUND', 'Payment owner was not found.');
}

async function addPurchase(tx: Transaction, payment: VerifiedPayment, now: Date) {
  const credits = packCredits[payment.packId];
  await tx.insert(ledgerEntries).values({
    userId: payment.userId,
    bucket: 'purchased',
    kind: 'purchase',
    amount: credits,
    idempotencyKey: `purchase:${payment.paymentId}`,
    createdAt: now,
  }).onConflictDoNothing();
  await recordEvent({
    userId: payment.userId,
    type: 'credits.purchased',
    subjectType: 'payment',
    subjectId: payment.paymentId,
    data: { packId: payment.packId, credits },
  }, tx);
  await tx.insert(payments).values({
    providerPaymentId: payment.paymentId,
    userId: payment.userId,
    packId: payment.packId,
    productId: payment.productId,
    credits,
    amountMinor: payment.totalAmountMinor,
    currency: payment.currency,
    status: 'succeeded',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}

async function applyRefund(tx: Transaction, refundId: string, paymentId: string, userId: string, credits: number, now: Date) {
  await tx.insert(ledgerEntries).values({
    userId,
    bucket: 'purchased',
    kind: 'refund',
    amount: -credits,
    idempotencyKey: `refund:${refundId}`,
    createdAt: now,
  }).onConflictDoNothing();
  await tx.update(paymentRefunds).set({ userId, status: 'applied', updatedAt: now }).where(eq(paymentRefunds.providerRefundId, refundId));
  await tx.update(payments).set({ status: 'refunded', updatedAt: now }).where(eq(payments.providerPaymentId, paymentId));
  await recordEvent({
    userId,
    type: 'credits.refunded',
    subjectType: 'payment',
    subjectId: paymentId,
    data: { refundId, credits },
  }, tx);
}

/** Records a provider-verified event and applies supported pack/refund ledger changes once. */
export async function recordPaymentEvent(
  input: RecordPaymentEventInput,
  database: Database = getDatabase(),
): Promise<RecordPaymentEventResult> {
  validate(input);
  const now = new Date();
  return database.transaction(async (tx) => {
    const [event] = await tx.insert(paymentEvents).values({
      webhookId: input.webhookId,
      type: input.type,
      userId: input.payment?.userId,
      paymentId: input.payment?.paymentId ?? input.refund?.paymentId,
      refundId: input.refund?.refundId,
      payload: input.payload,
      receivedAt: now,
    }).onConflictDoNothing().returning({ id: paymentEvents.id });
    if (!event) return { duplicate: true, action: 'logged' };

    // Also serializes a refund received before its payment row exists.
    const paymentKey = input.payment?.paymentId ?? input.refund?.paymentId;
    if (paymentKey)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${paymentKey}))`);

    if (input.payment) {
      const payment = input.payment;
      await lockUser(tx, payment.userId);
      const [previous] = await tx.select().from(payments).where(eq(payments.providerPaymentId, payment.paymentId)).for('update');
      if (previous && (previous.userId !== payment.userId || previous.packId !== payment.packId || previous.productId !== payment.productId))
        throw new PaymentEventError('PAYMENT_CONFLICT', 'This payment ID is already linked to another purchase.');
      if (previous) return { duplicate: false, action: 'logged' };
      await addPurchase(tx, payment, now);

      const pending = await tx.select().from(paymentRefunds)
        .where(and(eq(paymentRefunds.providerPaymentId, payment.paymentId), eq(paymentRefunds.status, 'pending_payment')))
        .orderBy(asc(paymentRefunds.createdAt), asc(paymentRefunds.id));
      let fullRefundApplied = false;
      let needsReview = false;
      for (const refund of pending) {
        if (refund.isPartial) {
          await tx.update(paymentRefunds).set({ userId: payment.userId, status: 'manual_review', updatedAt: now }).where(eq(paymentRefunds.id, refund.id));
          needsReview = true;
        } else if (!fullRefundApplied) {
          await applyRefund(tx, refund.providerRefundId, payment.paymentId, payment.userId, packCredits[payment.packId], now);
          fullRefundApplied = true;
        } else {
          await tx.update(paymentRefunds).set({ userId: payment.userId, status: 'manual_review', updatedAt: now }).where(eq(paymentRefunds.id, refund.id));
          needsReview = true;
        }
      }
      return { duplicate: false, action: needsReview ? 'manual_review' : fullRefundApplied ? 'refund_debited' : 'purchase_granted' };
    }

    if (input.refund) {
      const refund = input.refund;
      if (refund.status !== 'succeeded') return { duplicate: false, action: 'logged' };
      const [knownPayment] = await tx.select().from(payments).where(eq(payments.providerPaymentId, refund.paymentId));
      const userId = knownPayment?.userId;
      if (userId) await lockUser(tx, userId);
      const [payment] = await tx.select().from(payments).where(eq(payments.providerPaymentId, refund.paymentId)).for('update');
      const [record] = await tx.insert(paymentRefunds).values({
        providerRefundId: refund.refundId,
        providerPaymentId: refund.paymentId,
        userId,
        isPartial: refund.isPartial,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        status: payment ? (refund.isPartial || payment.status === 'refunded' ? 'manual_review' : 'applied') : 'pending_payment',
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning({ id: paymentRefunds.id });
      if (!record) return { duplicate: false, action: 'logged' };
      if (!payment) return { duplicate: false, action: 'logged' };
      if (refund.isPartial || payment.status === 'refunded') {
        await tx.update(paymentRefunds).set({ status: 'manual_review', updatedAt: now }).where(eq(paymentRefunds.id, record.id));
        return { duplicate: false, action: 'manual_review' };
      }
      await applyRefund(tx, refund.refundId, refund.paymentId, payment.userId, payment.credits, now);
      return { duplicate: false, action: 'refund_debited' };
    }

    return { duplicate: false, action: 'logged' };
  });
}
