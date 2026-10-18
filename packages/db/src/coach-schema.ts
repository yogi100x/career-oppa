import {
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
import { users } from './schema';
import { opportunities } from './roles-schema';

export const coachMessages = pgTable(
  'coach_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    requestKey: text('request_key'),
    replyToId: uuid('reply_to_id'),
    status: text('status').notNull().default('completed'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    promptVersion: text('prompt_version'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('coach_messages_user_request_unique')
      .on(table.userId, table.requestKey)
      .where(sql`${table.requestKey} IS NOT NULL`),
    uniqueIndex('coach_messages_reply_unique')
      .on(table.replyToId)
      .where(sql`${table.replyToId} IS NOT NULL`),
    index('coach_messages_user_created_idx').on(table.userId, table.createdAt),
    check(
      'coach_messages_role_check',
      sql`${table.role} IN ('user', 'assistant')`,
    ),
    check(
      'coach_messages_status_check',
      sql`${table.status} IN ('pending', 'completed', 'failed')`,
    ),
  ],
);

export const coachProposals = pgTable(
  'coach_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('change_status'),
    data: jsonb('data')
      .$type<{ from: string; to: string; reason: string }>()
      .notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('coach_proposals_user_created_idx').on(table.userId, table.createdAt),
  ],
);
