import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users, files } from './schema';
import { opportunities } from './roles-schema';
import type { ResumeContent } from '@career-workspace/contracts';

export const resumeVersions = pgTable(
  'resume_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    content: jsonb('content').$type<ResumeContent>().notNull(),
    version: integer('version').notNull(),
    groundingFlags: jsonb('grounding_flags')
      .$type<Array<{ index: number; codes: string[] }>>()
      .notNull()
      .default([]),
    promptVersion: text('prompt_version'),
    model: text('model'),
    restoredFromId: uuid('restored_from_id'),
    reusedFromId: uuid('reused_from_id'),
    requestKey: text('request_key'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    pdfFileId: uuid('pdf_file_id').references(() => files.id, {
      onDelete: 'set null',
    }),
    pageSize: text('page_size').notNull().default('A4'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('resume_versions_opportunity_version_unique').on(
      table.opportunityId,
      table.version,
    ),
    uniqueIndex('resume_versions_user_opportunity_request_key_unique').on(
      table.userId,
      table.opportunityId,
      table.requestKey,
    ),
    uniqueIndex('resume_versions_id_user_opportunity_unique').on(
      table.id,
      table.userId,
      table.opportunityId,
    ),
    foreignKey({
      name: 'resume_versions_opportunity_owner_fk',
      columns: [table.opportunityId, table.userId],
      foreignColumns: [opportunities.id, opportunities.userId],
    }).onDelete('cascade'),
    index('resume_versions_user_opportunity_idx').on(
      table.userId,
      table.opportunityId,
    ),
  ],
);
