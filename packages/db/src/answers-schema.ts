import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema';
import { opportunities } from './roles-schema';

export const answerDrafts = pgTable(
  'answer_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    factIds: jsonb('fact_ids').$type<string[]>().notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
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
    index('answer_drafts_user_opportunity_idx').on(
      table.userId,
      table.opportunityId,
    ),
  ],
);
