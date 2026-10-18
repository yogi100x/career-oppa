import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users, projects } from './schema';

export const socialConnections = pgTable(
  'social_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerProfileId: text('provider_profile_id').unique(),
    providerAccountId: text('provider_account_id').unique(),
    platform: text('platform').notNull(),
    displayName: text('display_name'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'social_connection_status_check',
      sql`${table.status} IN ('pending', 'connected', 'disconnected')`,
    ),
  ],
);

export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    factIds: jsonb('fact_ids').$type<string[]>().notNull(),
    destination: text('destination').notNull().default('copy'),
    socialConnectionId: uuid('social_connection_id').references(
      () => socialConnections.id,
      { onDelete: 'set null' },
    ),
    approvedContent: text('approved_content'),
    approvedDestination: jsonb('approved_destination').$type<{
      destination: string;
      connectionId: string | null;
      accountId: string | null;
      platform: string | null;
    }>(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    status: text('status').notNull().default('draft'),
    idempotencyKey: uuid('idempotency_key').notNull().defaultRandom().unique(),
    providerPostId: text('provider_post_id').unique(),
    publicUrl: text('public_url'),
    firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
    attemptAt: timestamp('attempt_at', { withTimezone: true }),
    attemptId: uuid('attempt_id'),
    errorCode: text('error_code'),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('posts_user_created_idx').on(table.userId, table.createdAt),
    check(
      'post_status_check',
      sql`${table.status} IN ('draft', 'approved', 'publishing', 'published', 'failed', 'unknown', 'copy_ready')`,
    ),
  ],
);

export const publishingEvents = pgTable(
  'publishing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerEventId: text('provider_event_id').notNull().unique(),
    providerPostId: text('provider_post_id').notNull(),
    payload: jsonb('payload')
      .$type<{
        status: string;
        accountId?: string;
        platform?: string;
        publicUrl?: string;
      }>()
      .notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('publishing_events_post_idx').on(table.providerPostId)],
);
