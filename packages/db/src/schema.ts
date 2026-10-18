import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
export * from './roles-schema';
export * from './resumes-schema';
export * from './answers-schema';
export * from './coach-schema';
export * from './reminders-schema';
export * from './payments-schema';
export * from './contacts-schema';
export * from './rewards-schema';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkId: text('clerk_id').notNull(),
    role: text('role').notNull().default('candidate'),
    coachId: text('coach_id').notNull().default('coach'),
    targetRoles: text('target_roles').array().notNull().default([]),
    preferredLocation: text('preferred_location').notNull().default(''),
    workPreference: text('work_preference').notNull().default('any'),
    paperSize: text('paper_size').notNull().default('A4'),
    // The CV header the student last confirmed; prefilled into new drafts.
    cvName: text('cv_name').notNull().default(''),
    cvContact: text('cv_contact').notNull().default(''),
    firstFitReviewUsed: boolean('first_fit_review_used')
      .notNull()
      .default(false),
    firstFitReviewRequestKey: text('first_fit_review_request_key'),
    firstFitReviewOpportunityId: uuid('first_fit_review_opportunity_id'),
    ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }),
    deletionRequestedAt: timestamp('deletion_requested_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('users_clerk_id_unique').on(table.clerkId),
    check('users_role_check', sql`${table.role} IN ('candidate', 'admin')`),
    check(
      'users_work_preference_check',
      sql`${table.workPreference} IN ('any', 'remote', 'hybrid', 'onsite')`,
    ),
    check(
      'users_paper_size_check',
      sql`${table.paperSize} IN ('A4', 'LETTER')`,
    ),
  ],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actorId: uuid('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    visibility: text('visibility').notNull().default('user'),
    data: jsonb('data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('events_user_subject_created_idx').on(
      table.userId,
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
    check(
      'events_visibility_check',
      sql`${table.visibility} IN ('user', 'internal')`,
    ),
  ],
);

export const rateLimits = pgTable(
  'rate_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    externalSubject: text('external_subject'),
    actionKey: text('action_key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true })
      .notNull()
      .defaultNow(),
    count: integer('count').notNull().default(1),
  },
  (table) => [
    uniqueIndex('rate_limits_user_action_unique').on(
      table.userId,
      table.actionKey,
    ),
    uniqueIndex('rate_limits_external_subject_action_unique').on(
      table.externalSubject,
      table.actionKey,
    ),
    check('rate_limits_count_positive_check', sql`${table.count} > 0`),
    check(
      'rate_limits_owner_check',
      sql`(${table.userId} IS NOT NULL AND ${table.externalSubject} IS NULL) OR (${table.userId} IS NULL AND ${table.externalSubject} IS NOT NULL)`,
    ),
  ],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    kind: text('kind').notNull(),
    originalName: text('original_name'),
    contentType: text('content_type'),
    size: integer('size'),
    contentHash: text('content_hash'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('files_r2_key_unique').on(table.r2Key),
    uniqueIndex('files_user_kind_hash_unique').on(
      table.userId,
      table.kind,
      table.contentHash,
    ),
    index('files_user_created_idx').on(table.userId, table.createdAt),
    check(
      'files_kind_check',
      sql`${table.kind} IN ('cv_upload', 'resume_pdf', 'portfolio', 'supporting_document')`,
    ),
    check(
      'files_size_nonnegative_check',
      sql`${table.size} IS NULL OR ${table.size} >= 0`,
    ),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    links: text('links').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('projects_user_updated_idx').on(table.userId, table.updatedAt),
    check(
      'projects_title_nonempty_check',
      sql`length(trim(${table.title})) > 0`,
    ),
  ],
);

export const profileFacts = pgTable(
  'profile_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    // Optional details from CV extraction; null for older or manual facts.
    organisation: text('organisation'),
    role: text('role'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    sourceQuote: text('source_quote'),
    source: text('source').notNull(),
    status: text('status').notNull().default('proposed'),
    sourceFileId: uuid('source_file_id').references(() => files.id, {
      onDelete: 'set null',
    }),
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('profile_facts_user_status_created_idx').on(
      table.userId,
      table.status,
      table.createdAt,
    ),
    index('profile_facts_source_file_idx').on(table.sourceFileId),
    index('profile_facts_project_idx').on(table.projectId),
    check(
      'profile_facts_kind_check',
      sql`${table.kind} IN ('experience', 'skill', 'education', 'achievement', 'certification', 'project', 'volunteering', 'responsibility', 'language', 'eligibility')`,
    ),
    check(
      'profile_facts_source_check',
      sql`${table.source} IN ('cv', 'user', 'chat', 'project')`,
    ),
    check(
      'profile_facts_status_check',
      sql`${table.status} IN ('proposed', 'approved', 'rejected')`,
    ),
    check(
      'profile_facts_text_nonempty_check',
      sql`length(trim(${table.text})) > 0`,
    ),
    check(
      'profile_facts_project_source_check',
      sql`(${table.source} = 'project' AND ${table.projectId} IS NOT NULL) OR (${table.source} <> 'project' AND ${table.projectId} IS NULL)`,
    ),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: text('error'),
    idempotencyKey: text('idempotency_key').notNull(),
    holdId: uuid('hold_id').references(() => creditHolds.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('tasks_idempotency_key_unique').on(table.idempotencyKey),
    index('tasks_user_status_created_idx').on(
      table.userId,
      table.status,
      table.createdAt,
    ),
    check(
      'tasks_status_check',
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`,
    ),
    check('tasks_attempts_nonnegative_check', sql`${table.attempts} >= 0`),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    amount: integer('amount').notNull(),
    bucket: text('bucket').notNull(),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('ledger_entries_user_created_idx').on(table.userId, table.createdAt),
    uniqueIndex('ledger_entries_idempotency_key_unique')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      'ledger_entries_bucket_check',
      sql`${table.bucket} IN ('free', 'earned', 'purchased')`,
    ),
    check(
      'ledger_entries_kind_check',
      sql`${table.kind} IN ('grant', 'expire', 'debit', 'purchase', 'refund', 'reward', 'adjust')`,
    ),
    check('ledger_entries_amount_nonzero_check', sql`${table.amount} <> 0`),
  ],
);

export const creditHolds = pgTable(
  'credit_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actionKey: text('action_key').notNull(),
    amount: integer('amount').notNull(),
    bucketSplit: jsonb('bucket_split')
      .$type<Record<string, number>>()
      .notNull(),
    status: text('status').notNull().default('reserved'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resultType: text('result_type'),
    resultId: text('result_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('credit_holds_user_status_expires_idx').on(
      table.userId,
      table.status,
      table.expiresAt,
    ),
    uniqueIndex('credit_holds_idempotency_active_unique')
      .on(table.idempotencyKey)
      .where(sql`${table.status} IN ('reserved', 'settled')`),
    check('credit_holds_amount_positive_check', sql`${table.amount} > 0`),
    check(
      'credit_holds_status_check',
      sql`${table.status} IN ('reserved', 'settled', 'released', 'expired')`,
    ),
  ],
);

export const publicJobDiscoverySources = pgTable(
  'public_job_discovery_sources',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    board: text('board').notNull(),
    company: text('company').notNull(),
    status: text('status').notNull().default('idle'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    errorCode: text('error_code'),
    claimToken: uuid('claim_token'),
    catalogActive: boolean('catalog_active').notNull().default(true),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
    deadUntilAt: timestamp('dead_until_at', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  },
  (table) => [
    index('public_job_discovery_sources_catalog_retry_idx').on(
      table.catalogActive,
      table.nextRetryAt,
    ),
    check(
      'public_job_discovery_sources_status_check',
      sql`${table.status} IN ('idle', 'running', 'succeeded', 'failed')`,
    ),
    check(
      'public_job_discovery_sources_failure_count_check',
      sql`${table.failureCount} >= 0`,
    ),
  ],
);

export const discoveryCollectionState = pgTable(
  'discovery_collection_state',
  {
    id: text('id').primaryKey().default('global'),
    cursor: integer('cursor').notNull().default(0),
    datasetFetchedAt: timestamp('dataset_fetched_at', { withTimezone: true }),
    datasetAttemptAt: timestamp('dataset_attempt_at', { withTimezone: true }),
    datasetClaimToken: uuid('dataset_claim_token'),
    datasetClaimedAt: timestamp('dataset_claimed_at', { withTimezone: true }),
    datasetError: text('dataset_error'),
    currentSweepKey: text('current_sweep_key'),
  },
  (table) => [
    check(
      'discovery_collection_state_global_id_check',
      sql`${table.id} = 'global'`,
    ),
    check('discovery_collection_state_cursor_check', sql`${table.cursor} >= 0`),
  ],
);

export const discoverySweeps = pgTable(
  'discovery_sweeps',
  {
    key: text('key').primaryKey(),
    sourceIds: jsonb('source_ids').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    halted: boolean('halted').notNull().default(false),
    nextIndex: integer('next_index').notNull().default(0),
    refreshed: integer('refreshed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
  },
  (table) => [
    check(
      'discovery_sweeps_source_ids_array_check',
      sql`jsonb_typeof(${table.sourceIds}) = 'array'`,
    ),
    check(
      'discovery_sweeps_consecutive_failures_check',
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check('discovery_sweeps_next_index_check', sql`${table.nextIndex} >= 0`),
    check('discovery_sweeps_refreshed_check', sql`${table.refreshed} >= 0`),
    check('discovery_sweeps_failed_check', sql`${table.failed} >= 0`),
    check('discovery_sweeps_skipped_check', sql`${table.skipped} >= 0`),
  ],
);

export const publicJobDiscoveryJobs = pgTable(
  'public_job_discovery_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: text('source_id')
      .notNull()
      .references(() => publicJobDiscoverySources.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    canonicalUrlHash: text('canonical_url_hash').notNull(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location').notNull(),
    workMode: text('work_mode').notNull(),
    url: text('url').notNull(),
    text: text('text').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('public_job_discovery_jobs_canonical_url_hash_unique').on(
      table.canonicalUrlHash,
    ),
    uniqueIndex('public_job_discovery_jobs_source_external_unique').on(
      table.sourceId,
      table.externalId,
    ),
    index('public_job_discovery_jobs_active_last_seen_idx').on(
      table.active,
      table.lastSeenAt,
    ),
    index('public_job_discovery_jobs_active_freshness_idx').on(
      table.active,
      sql`COALESCE(${table.postedAt}, ${table.firstSeenAt})`,
    ),
    check(
      'public_job_discovery_jobs_work_mode_check',
      sql`${table.workMode} IN ('remote', 'hybrid', 'onsite', 'unknown')`,
    ),
  ],
);

export const discoveryJobSightings = pgTable(
  'discovery_job_sightings',
  {
    canonicalUrlHash: text('canonical_url_hash').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => publicJobDiscoverySources.id, { onDelete: 'cascade' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('discovery_job_sightings_source_idx').on(table.sourceId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type RateLimit = typeof rateLimits.$inferSelect;
export type NewRateLimit = typeof rateLimits.$inferInsert;
export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProfileFact = typeof profileFacts.$inferSelect;
export type NewProfileFact = typeof profileFacts.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type CreditHold = typeof creditHolds.$inferSelect;
export type NewCreditHold = typeof creditHolds.$inferInsert;
export * from './outreach-schema';
export * from './practice-schema';
export * from './publishing-schema';
export * from './application-handoffs-schema';
export * from './telegram-schema';
