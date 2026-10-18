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
import type {
  PracticeFeedback,
  PracticeQuestion,
} from '@career-workspace/contracts';

export const practiceSessions = pgTable(
  'practice_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    questions: jsonb('questions').$type<PracticeQuestion[]>().notNull(),
    answers: jsonb('answers').$type<string[]>().notNull().default([]),
    feedback: jsonb('feedback').$type<PracticeFeedback>(),
    status: text('status').notNull().default('questions_ready'),
    answerHash: text('answer_hash'),
    feedbackAttempt: uuid('feedback_attempt'),
    questionPromptVersion: text('question_prompt_version').notNull(),
    feedbackPromptVersion: text('feedback_prompt_version'),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('practice_user_role_created_idx').on(
      table.userId,
      table.opportunityId,
      table.createdAt,
    ),
    check(
      'practice_status_check',
      sql`${table.status} IN ('questions_ready', 'generating_feedback', 'completed')`,
    ),
  ],
);
