import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  FitReviewRequirement,
  FitScorecard,
} from '@career-workspace/contracts';
import { users } from './schema';

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    url: text('url'),
    canonicalUrlHash: text('canonical_url_hash'),
    textHash: text('text_hash').notNull(),
    text: text('text').notNull(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('jobs_user_url_unique')
      .on(table.userId, table.canonicalUrlHash)
      .where(sql`${table.canonicalUrlHash} IS NOT NULL`),
    index('jobs_user_created_idx').on(table.userId, table.createdAt),
    check(
      'jobs_source_check',
      sql`${table.source} IN ('url', 'paste', 'extension')`,
    ),
  ],
);

export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('saved'),
    nextStep: text('next_step')
      .notNull()
      .default('Review your fit for this role'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('opportunities_job_unique').on(table.jobId),
    uniqueIndex('opportunities_id_user_unique').on(table.id, table.userId),
    index('opportunities_user_created_idx').on(table.userId, table.createdAt),
    check(
      'opportunities_status_check',
      sql`${table.status} IN ('saved', 'reviewed', 'preparing', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn')`,
    ),
  ],
);

export const fitReviews = pgTable(
  'fit_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    verdict: text('verdict').notNull(),
    strengths: jsonb('strengths')
      .$type<Array<{ text: string; fact_ids: string[] }>>()
      .notNull(),
    gaps: jsonb('gaps').$type<string[]>().notNull(),
    unknowns: jsonb('unknowns').$type<string[]>().notNull(),
    scorecard: jsonb('scorecard').$type<FitScorecard>(),
    requirements: jsonb('requirements').$type<FitReviewRequirement[]>(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    isFree: boolean('is_free').notNull().default(false),
    requestKey: text('request_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('fit_reviews_user_opportunity_idx').on(
      table.userId,
      table.opportunityId,
      table.createdAt,
    ),
    uniqueIndex('fit_reviews_one_free_per_user_unique')
      .on(table.userId)
      .where(sql`${table.isFree}`),
    uniqueIndex('fit_reviews_user_request_key_unique')
      .on(table.userId, table.requestKey)
      .where(sql`${table.requestKey} IS NOT NULL`),
  ],
);
