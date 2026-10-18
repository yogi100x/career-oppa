import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  createDatabase,
  ledgerEntries,
  paymentEvents,
  paymentRefunds,
  payments,
  users,
} from '@career-workspace/db';
import { balance, reserve } from './credits/index';
import { listCreditPacks, recordPaymentEvent } from './payments';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('verified payment events', () => {
  const { database, pool } = createDatabase(url!);
  const userIds: string[] = [];
  const webhookIds: string[] = [];
  const providerPaymentIds: string[] = [];
  const providerRefundIds: string[] = [];

  afterAll(async () => {
    if (userIds.length) await database.delete(users).where(inArray(users.id, userIds));
    if (webhookIds.length) await database.delete(paymentEvents).where(inArray(paymentEvents.webhookId, webhookIds));
    if (providerRefundIds.length) await database.delete(paymentRefunds).where(inArray(paymentRefunds.providerRefundId, providerRefundIds));
    if (providerPaymentIds.length) await database.delete(payments).where(inArray(payments.providerPaymentId, providerPaymentIds));
    await pool.end();
  });

  async function newUser() {
    const [user] = await database.insert(users).values({ clerkId: `payment-test-${randomUUID()}` }).returning();
    userIds.push(user.id);
    return user.id;
  }

  async function payment(userId: string, paymentId = `pay_${randomUUID()}`) {
    providerPaymentIds.push(paymentId);
    return {
      webhookId: `wh_${randomUUID()}`,
      type: 'payment.succeeded',
      payload: { paymentId },
      payment: {
        paymentId,
        userId,
        packId: 'starter' as const,
        productId: 'test_product',
        quantity: 1,
        totalAmountMinor: 575,
        currency: 'USD',
      },
    };
  }

  it('lists fixed packs and grants a payment once across webhook retries', async () => {
    if (new URL(url!).pathname !== '/career_workspace_test') throw new Error('Use career_workspace_test only.');
    expect(listCreditPacks().map(({ id, credits }) => [id, credits])).toEqual([
      ['starter', 100], ['job_hunt', 300], ['full_season', 750],
    ]);
    const userId = await newUser();
    const input = await payment(userId);
    webhookIds.push(input.webhookId);
    const first = await recordPaymentEvent(input, database);
    expect(first).toEqual({ duplicate: false, action: 'purchase_granted' });
    const retry = await recordPaymentEvent(input, database);
    expect(retry).toEqual({ duplicate: true, action: 'logged' });
    const duplicateWebhookId = `wh_${randomUUID()}`;
    webhookIds.push(duplicateWebhookId);
    const duplicateDelivery = await recordPaymentEvent({ ...input, webhookId: duplicateWebhookId }, database);
    expect(duplicateDelivery.action).toBe('logged');
    const purchase = await database.select().from(ledgerEntries).where(and(eq(ledgerEntries.userId, userId), eq(ledgerEntries.idempotencyKey, `purchase:${input.payment.paymentId}`)));
    expect(purchase).toHaveLength(1);
    const [stored] = await database.select().from(payments).where(eq(payments.providerPaymentId, input.payment.paymentId));
    expect(stored.amountMinor).toBe(575);
  });

  it('applies full refunds as debt, while partial refunds stay in manual review', async () => {
    const userId = await newUser();
    const full = await payment(userId);
    webhookIds.push(full.webhookId);
    await recordPaymentEvent(full, database);
    await database.insert(ledgerEntries).values({
      userId,
      bucket: 'purchased',
      kind: 'debit',
      amount: -40,
      idempotencyKey: `spent-before-refund:${randomUUID()}`,
    });
    const fullRefundId = `rf_${randomUUID()}`;
    const fullRefundWebhook = `wh_${randomUUID()}`;
    providerRefundIds.push(fullRefundId);
    webhookIds.push(fullRefundWebhook);
    const refunded = await recordPaymentEvent({
      webhookId: fullRefundWebhook,
      type: 'refund.succeeded',
      payload: { refundId: fullRefundId },
      refund: { refundId: fullRefundId, paymentId: full.payment.paymentId, isPartial: false, status: 'succeeded', amountMinor: 575, currency: 'USD' },
    }, database);
    expect(refunded.action).toBe('refund_debited');
    const current = await balance(userId, { database });
    expect(current.buckets.purchased).toBe(-40);

    const second = await payment(userId);
    webhookIds.push(second.webhookId);
    await recordPaymentEvent(second, database);
    const partialRefundId = `rf_${randomUUID()}`;
    const partialWebhook = `wh_${randomUUID()}`;
    providerRefundIds.push(partialRefundId);
    webhookIds.push(partialWebhook);
    const partial = await recordPaymentEvent({
      webhookId: partialWebhook,
      type: 'refund.succeeded',
      payload: { refundId: partialRefundId },
      refund: { refundId: partialRefundId, paymentId: second.payment.paymentId, isPartial: true, status: 'succeeded', amountMinor: 100, currency: 'USD' },
    }, database);
    expect(partial.action).toBe('manual_review');
    const [refund] = await database.select().from(paymentRefunds).where(eq(paymentRefunds.providerRefundId, partialRefundId));
    expect(refund.status).toBe('manual_review');
  });

  it('records an out-of-order full refund and applies it once after its payment arrives', async () => {
    const userId = await newUser();
    const paymentId = `pay_${randomUUID()}`;
    const refundId = `rf_${randomUUID()}`;
    const refundWebhook = `wh_${randomUUID()}`;
    providerPaymentIds.push(paymentId);
    providerRefundIds.push(refundId);
    webhookIds.push(refundWebhook);
    const partialRefundId = `rf_${randomUUID()}`;
    const partialWebhookId = `wh_${randomUUID()}`;
    providerRefundIds.push(partialRefundId);
    webhookIds.push(partialWebhookId);
    const pending = await recordPaymentEvent({
      webhookId: refundWebhook,
      type: 'refund.succeeded',
      payload: { refundId },
      refund: { refundId, paymentId, isPartial: false, status: 'succeeded', amountMinor: 575, currency: 'USD' },
    }, database);
    expect(pending.action).toBe('logged');
    await recordPaymentEvent({
      webhookId: partialWebhookId,
      type: 'refund.succeeded',
      payload: { refundId: partialRefundId },
      refund: { refundId: partialRefundId, paymentId, isPartial: true, status: 'succeeded', amountMinor: 100, currency: 'USD' },
    }, database);
    const input = await payment(userId, paymentId);
    webhookIds.push(input.webhookId);
    const applied = await recordPaymentEvent(input, database);
    expect(applied.action).toBe('manual_review');
    const rows = await database.select().from(ledgerEntries).where(and(eq(ledgerEntries.userId, userId), inArray(ledgerEntries.idempotencyKey, [`purchase:${paymentId}`, `refund:${refundId}`])));
    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([-100, 100]);
    const [partial] = await database.select().from(paymentRefunds).where(eq(paymentRefunds.providerRefundId, partialRefundId));
    expect(partial.status).toBe('manual_review');
  });

  it('serializes a payment and its refund when both arrive at the same time', async () => {
    const userId = await newUser();
    const input = await payment(userId);
    const refundId = `rf_${randomUUID()}`;
    const refundWebhookId = `wh_${randomUUID()}`;
    providerRefundIds.push(refundId);
    webhookIds.push(input.webhookId, refundWebhookId);
    await Promise.all([
      recordPaymentEvent(input, database),
      recordPaymentEvent({
        webhookId: refundWebhookId,
        type: 'refund.succeeded',
        payload: { refundId },
        refund: { refundId, paymentId: input.payment.paymentId, isPartial: false, status: 'succeeded', amountMinor: 575, currency: 'USD' },
      }, database),
    ]);
    const rows = await database.select().from(ledgerEntries).where(and(eq(ledgerEntries.userId, userId), inArray(ledgerEntries.idempotencyKey, [`purchase:${input.payment.paymentId}`, `refund:${refundId}`])));
    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([-100, 100]);
  });

  it('keeps purchased debt visible without hiding free credits from the spendable balance', async () => {
    const userId = await newUser();
    const input = await payment(userId);
    webhookIds.push(input.webhookId);
    await recordPaymentEvent(input, database);
    await database.insert(ledgerEntries).values({ userId, bucket: 'purchased', kind: 'refund', amount: -150, idempotencyKey: `manual-debt:${randomUUID()}` });
    const current = await balance(userId, { database });
    expect(current.availableBuckets.purchased).toBe(-50);
    expect(current.available).toBe(30);
    const held = await reserve(userId, 'tailor_cv', `debt-${randomUUID()}`, { database });
    expect(held.status).toBe('reserved');
  });
});
