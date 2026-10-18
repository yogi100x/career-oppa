import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { opportunities } from './roles-schema';
import { users } from './schema';

/** Shared company identity only; candidate contact records remain private. */
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    domain: text('domain'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('companies_normalized_name_unique').on(table.normalizedName),
    uniqueIndex('companies_domain_unique')
      .on(table.domain)
      .where(sql`${table.domain} IS NOT NULL`),
    check(
      'companies_name_nonempty_check',
      sql`length(trim(${table.name})) > 0`,
    ),
  ],
);

/** One user's saved result from a GetLeads contact search. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    providerContactId: text('provider_contact_id').notNull(),
    providerProfileUrl: text('provider_profile_url'),
    name: text('name').notNull(),
    title: text('title').notNull().default(''),
    email: text('email'),
    emailStatus: text('email_status').notNull().default('unknown'),
    revealedAt: timestamp('revealed_at', { withTimezone: true }),
    source: text('source').notNull().default('getleads'),
    sourceDate: timestamp('source_date', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('contacts_user_opportunity_provider_unique').on(
      table.userId,
      table.opportunityId,
      table.providerContactId,
    ),
    index('contacts_user_opportunity_created_idx').on(
      table.userId,
      table.opportunityId,
      table.createdAt,
    ),
    check(
      'contacts_email_status_check',
      sql`${table.emailStatus} IN ('unknown', 'VALID', 'CATCH_ALL')`,
    ),
    check('contacts_source_check', sql`${table.source} = 'getleads'`),
    check(
      'contacts_reveal_consistency_check',
      sql`(${table.email} IS NULL AND ${table.revealedAt} IS NULL) OR (${table.email} IS NOT NULL AND ${table.revealedAt} IS NOT NULL)`,
    ),
  ],
);

/** Stores only a normalized email hash, never the suppressed address. */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailHash: text('email_hash').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('suppressions_email_hash_unique').on(table.emailHash),
    index('suppressions_created_at_idx').on(table.createdAt),
    check(
      'suppressions_reason_nonempty_check',
      sql`length(trim(${table.reason})) > 0`,
    ),
  ],
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Suppression = typeof suppressions.$inferSelect;
export type NewSuppression = typeof suppressions.$inferInsert;
