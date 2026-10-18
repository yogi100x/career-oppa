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
import { users } from './schema';
import { opportunities } from './roles-schema';
import { contacts } from './contacts-schema';

export const outreachDrafts = pgTable(
  'outreach_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    factIds: jsonb('fact_ids').$type<string[]>().notNull(),
    status: text('status').notNull().default('draft'),
    handoffMethod: text('handoff_method'),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    handedOffAt: timestamp('handed_off_at', { withTimezone: true }),
    markedSentAt: timestamp('marked_sent_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('outreach_user_opportunity_created_idx').on(
      table.userId,
      table.opportunityId,
      table.createdAt,
    ),
    check(
      'outreach_status_check',
      sql`${table.status} IN ('draft', 'handed_off', 'marked_sent')`,
    ),
    check(
      'outreach_handoff_method_check',
      sql`${table.handoffMethod} IS NULL OR ${table.handoffMethod} IN ('copy', 'mailto')`,
    ),
  ],
);
