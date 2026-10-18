import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema';

export const rewardSubmissions = pgTable(
  'reward_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    urlHash: text('url_hash').notNull(),
    disclosureConfirmed: boolean('disclosure_confirmed').notNull().default(true),
    status: text('status').notNull().default('pending'),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('reward_submissions_url_hash_unique').on(table.urlHash),
    index('reward_submissions_user_created_idx').on(table.userId, table.submittedAt),
    index('reward_submissions_status_created_idx').on(table.status, table.submittedAt),
    check('reward_submissions_status_check', sql`${table.status} IN ('pending', 'approved', 'rejected')`),
    check('reward_submissions_disclosure_check', sql`${table.disclosureConfirmed} = true`),
    check('reward_submissions_reason_check', sql`${table.status} <> 'rejected' OR length(trim(coalesce(${table.reason}, ''))) > 0`),
  ],
);

export type RewardSubmission = typeof rewardSubmissions.$inferSelect;
export type NewRewardSubmission = typeof rewardSubmissions.$inferInsert;
