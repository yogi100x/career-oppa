import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './schema';

/** Verified webhook deliveries, including event types the app does not process. */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: text('webhook_id').notNull(),
    type: text('type').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    paymentId: text('payment_id'),
    refundId: text('refund_id'),
    payload: jsonb('payload').$type<unknown>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('payment_events_webhook_id_unique').on(table.webhookId),
    index('payment_events_payment_id_idx').on(table.paymentId),
  ],
);

/** One successful fixed credit-pack payment from the provider. */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerPaymentId: text('provider_payment_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packId: text('pack_id').notNull(),
    productId: text('product_id').notNull(),
    credits: integer('credits').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    status: text('status').notNull().default('succeeded'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('payments_provider_payment_id_unique').on(
      table.providerPaymentId,
    ),
    index('payments_user_created_idx').on(table.userId, table.createdAt),
    check(
      'payments_pack_id_check',
      sql`${table.packId} IN ('starter', 'job_hunt', 'full_season')`,
    ),
    check('payments_credits_positive_check', sql`${table.credits} > 0`),
    check('payments_amount_nonnegative_check', sql`${table.amountMinor} >= 0`),
    check(
      'payments_status_check',
      sql`${table.status} IN ('succeeded', 'refunded', 'manual_review')`,
    ),
  ],
);

/** Refunds may arrive before their payment webhook, so providerPaymentId is text. */
export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerRefundId: text('provider_refund_id').notNull(),
    providerPaymentId: text('provider_payment_id').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    isPartial: boolean('is_partial').notNull(),
    amountMinor: integer('amount_minor'),
    currency: text('currency'),
    status: text('status').notNull().default('pending_payment'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('payment_refunds_provider_refund_id_unique').on(
      table.providerRefundId,
    ),
    index('payment_refunds_provider_payment_id_idx').on(
      table.providerPaymentId,
    ),
    check(
      'payment_refunds_amount_nonnegative_check',
      sql`${table.amountMinor} IS NULL OR ${table.amountMinor} >= 0`,
    ),
    check(
      'payment_refunds_status_check',
      sql`${table.status} IN ('pending_payment', 'applied', 'manual_review')`,
    ),
  ],
);

export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;
export type PaymentRecord = typeof payments.$inferSelect;
export type NewPaymentRecord = typeof payments.$inferInsert;
export type PaymentRefund = typeof paymentRefunds.$inferSelect;
export type NewPaymentRefund = typeof paymentRefunds.$inferInsert;
