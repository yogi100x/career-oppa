import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './schema';
import { opportunities } from './roles-schema';
import { contacts } from './contacts-schema';
import { outreachDrafts } from './outreach-schema';

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'cascade',
    }),
    outreachId: uuid('outreach_id').references(() => outreachDrafts.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    status: text('status').notNull().default('pending'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('reminders_outreach_unique')
      .on(table.outreachId)
      .where(sql`${table.outreachId} IS NOT NULL`),
    index('reminders_user_status_due_idx').on(
      table.userId,
      table.status,
      table.dueAt,
    ),
    check(
      'reminders_status_check',
      sql`${table.status} IN ('pending', 'done', 'stopped')`,
    ),
  ],
);
