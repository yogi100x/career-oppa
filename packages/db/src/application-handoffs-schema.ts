import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { opportunities } from './roles-schema';
import { resumeVersions } from './resumes-schema';
import { users } from './schema';

export const applicationHandoffs = pgTable(
  'application_handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    resumeId: uuid('resume_id').references(() => resumeVersions.id, {
      onDelete: 'set null',
    }),
    source: text('source').notNull(),
    response: text('response'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'application_handoffs_source_check',
      sql`${table.source} IN ('approved_pdf', 'employer_link')`,
    ),
    check(
      'application_handoffs_response_check',
      sql`${table.response} IS NULL OR ${table.response} IN ('applied', 'not_yet')`,
    ),
    check(
      'application_handoffs_answer_pair_check',
      sql`(${table.response} IS NULL AND ${table.answeredAt} IS NULL) OR (${table.response} IS NOT NULL AND ${table.answeredAt} IS NOT NULL)`,
    ),
    foreignKey({
      name: 'application_handoffs_opportunity_owner_fk',
      columns: [table.opportunityId, table.userId],
      foreignColumns: [opportunities.id, opportunities.userId],
    }).onDelete('cascade'),
    // 0022 creates this composite FK as DEFERRABLE INITIALLY DEFERRED in SQL.
    // Drizzle cannot declare deferrability. Keep the catalog and delete behavior
    // regression in migration-verification.test.ts aligned with this DDL: it
    // lets the existing single-column FK SET NULL action run before checking
    // that any remaining resume reference has the same owner and opportunity.
    foreignKey({
      name: 'application_handoffs_resume_owner_fk',
      columns: [table.resumeId, table.userId, table.opportunityId],
      foreignColumns: [
        resumeVersions.id,
        resumeVersions.userId,
        resumeVersions.opportunityId,
      ],
    }),
    uniqueIndex('application_handoffs_one_pending_idx')
      .on(table.userId, table.opportunityId)
      .where(sql`${table.answeredAt} IS NULL`),
    index('application_handoffs_user_pending_idx').on(
      table.userId,
      table.answeredAt,
      table.createdAt,
    ),
  ],
);
