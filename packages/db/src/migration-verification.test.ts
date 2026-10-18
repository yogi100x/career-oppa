import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, type Transaction } from './client';

const root = resolve(import.meta.dirname, '..');
const migrations = resolve(root, 'migrations');
const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

async function migrationFile(name: string) {
  return readFile(resolve(migrations, name), 'utf8');
}

async function migrationJournal() {
  return JSON.parse(
    await readFile(resolve(migrations, 'meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };
}

describe('migration history consistency', () => {
  it('keeps the restored discovery migration before handoff integrity and adds a later repair', async () => {
    const journal = await migrationJournal();
    const byTag = new Map(journal.entries.map((entry) => [entry.tag, entry]));
    const discovery = byTag.get('0021_job_discovery_pool');
    const handoff = byTag.get('0022_application_handoff_integrity');
    const repair = byTag.get('0023_restore_discovery_pool');
    expect(discovery).toBeDefined();
    expect(handoff).toBeDefined();
    expect(repair).toBeDefined();
    expect([discovery!.idx, handoff!.idx, repair!.idx]).toEqual([21, 22, 23]);
    expect(discovery!.when).toBeLessThan(handoff!.when);
    expect(handoff!.when).toBeLessThan(repair!.when);

    const migration22 = await migrationFile(
      '0022_application_handoff_integrity.sql',
    );
    expect(migration22).toContain('DEFERRABLE INITIALLY DEFERRED');
    const snapshot21 = JSON.parse(
      await readFile(resolve(migrations, 'meta/0021_snapshot.json'), 'utf8'),
    ) as { id: string; tables: Record<string, unknown> };
    const snapshot22 = JSON.parse(
      await readFile(resolve(migrations, 'meta/0022_snapshot.json'), 'utf8'),
    ) as { id: string; prevId: string; tables: Record<string, unknown> };
    const snapshot23 = JSON.parse(
      await readFile(resolve(migrations, 'meta/0023_snapshot.json'), 'utf8'),
    ) as { prevId: string; tables: Record<string, unknown> };
    expect(snapshot22.prevId).toBe(snapshot21.id);
    expect(snapshot23.prevId).toBe(snapshot22.id);
    for (const table of [
      'public.public_job_discovery_jobs',
      'public.public_job_discovery_sources',
    ]) {
      expect(snapshot21.tables[table]).toBeDefined();
      expect(snapshot22.tables[table]).toBeDefined();
      expect(snapshot23.tables[table]).toBeDefined();
    }

    const snapshot31 = JSON.parse(
      await readFile(resolve(migrations, 'meta/0031_snapshot.json'), 'utf8'),
    ) as { id: string };
    const snapshot32 = JSON.parse(
      await readFile(resolve(migrations, 'meta/0032_snapshot.json'), 'utf8'),
    ) as { prevId: string; tables: Record<string, unknown> };
    const snapshot33 = JSON.parse(
      await readFile(resolve(migrations, 'meta/0033_snapshot.json'), 'utf8'),
    ) as { prevId: string; tables: Record<string, unknown> };
    const snapshot34 = JSON.parse(
      await readFile(resolve(migrations, 'meta/0034_snapshot.json'), 'utf8'),
    ) as { prevId: string; tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }> };
    expect(snapshot32.prevId).toBe(snapshot31.id);
    expect(snapshot33.prevId).toBe(
      (JSON.parse(
        await readFile(resolve(migrations, 'meta/0032_snapshot.json'), 'utf8'),
      ) as { id: string }).id,
    );
    expect(snapshot34.prevId).toBe(
      (JSON.parse(
        await readFile(resolve(migrations, 'meta/0033_snapshot.json'), 'utf8'),
      ) as { id: string }).id,
    );
    for (const table of [
      'public.discovery_collection_state',
      'public.discovery_sweeps',
      'public.discovery_job_sightings',
    ]) {
      expect(snapshot32.tables[table]).toBeDefined();
    }
    for (const [table, columns] of Object.entries({
      'public.users': [
        'first_fit_review_used',
        'first_fit_review_request_key',
        'first_fit_review_opportunity_id',
      ],
      'public.fit_reviews': ['is_free', 'request_key'],
      'public.public_job_discovery_sources': [
        'catalog_active',
        'verified_at',
        'failure_count',
        'dead_until_at',
        'next_retry_at',
      ],
    })) {
      const snapshotTable = snapshot32.tables[table] as {
        columns: Record<string, unknown>;
      };
      for (const column of columns)
        expect(snapshotTable.columns[column]).toBeDefined();
    }
    const fitReviews33 = snapshot33.tables['public.fit_reviews'] as {
      columns: Record<string, { notNull?: boolean; type?: string }>;
    };
    expect(fitReviews33.columns.scorecard).toMatchObject({
      type: 'jsonb',
      notNull: false,
    });
    expect(fitReviews33.columns.requirements).toMatchObject({
      type: 'jsonb',
      notNull: false,
    });
    const resumeVersions34 = snapshot34.tables['public.resume_versions'];
    expect(resumeVersions34.columns.request_key).toMatchObject({
      type: 'text',
      notNull: false,
    });
    expect(resumeVersions34.indexes.resume_versions_user_opportunity_request_key_unique).toBeDefined();
    expect(await migrationFile('0033_fit_review_scorecard.sql')).toContain(
      'ADD COLUMN IF NOT EXISTS "scorecard" jsonb',
    );
    expect(await migrationFile('0033_fit_review_scorecard.sql')).toContain(
      'ADD COLUMN IF NOT EXISTS "requirements" jsonb',
    );
    expect(await migrationFile('0034_resume_copy_request_key.sql')).toContain(
      'ADD COLUMN IF NOT EXISTS "request_key" text',
    );
    expect(await migrationFile('0034_resume_copy_request_key.sql')).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "resume_versions_user_opportunity_request_key_unique"',
    );

    const repairSql = await migrationFile('0023_restore_discovery_pool.sql');
    expect(repairSql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    expect(
      repairSql.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g),
    ).toHaveLength(3);
    expect(repairSql).toContain('IF NOT EXISTS (SELECT 1 FROM pg_constraint');
    expect(repairSql).toContain(
      "conrelid = to_regclass(format('%I.%I', current_schema(), 'public_job_discovery_sources'))",
    );
    expect(repairSql).toContain(
      "conrelid = to_regclass(format('%I.%I', current_schema(), 'public_job_discovery_jobs'))",
    );
  });
});

integration('migration behavior in a rollback-only test schema', () => {
  const { database, pool } = createDatabase(databaseUrl!);

  beforeAll(() => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
  });

  afterAll(async () => pool.end());

  async function applyMigration(
    tx: Transaction,
    contents: string,
    schema: string,
  ) {
    const statements = contents
      .replaceAll('"public".', `"${schema}".`)
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await tx.execute(sql.raw(statement));
  }

  async function applyJournal(
    tx: Transaction,
    schema: string,
    skipIdx21: boolean,
    skipIdx32 = false,
    skipIdx33 = false,
    skipIdx34 = false,
  ) {
    const { entries } = await migrationJournal();
    for (const entry of entries) {
      if (skipIdx21 && entry.idx === 21) continue;
      if (skipIdx32 && entry.idx === 32) continue;
      if (skipIdx33 && entry.idx === 33) continue;
      if (skipIdx34 && entry.idx === 34) continue;
      await applyMigration(tx, await migrationFile(`${entry.tag}.sql`), schema);
    }
  }

  async function verifyMigrationPath(skipIdx21: boolean) {
    await database
      .transaction(async (tx) => {
        const schema = `migration_check_${randomUUID().replaceAll('-', '')}`;
        await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
        await tx.execute(
          sql`SET LOCAL search_path TO ${sql.identifier(schema)}`,
        );
        await applyJournal(tx, schema, skipIdx21);
        // Migration 0030 can safely be retried after a partially applied deploy.
        await applyMigration(
          tx,
          await migrationFile('0030_free_first_fit_review.sql'),
          schema,
        );
        await applyMigration(
          tx,
          await migrationFile('0023_restore_discovery_pool.sql'),
          schema,
        );

        await tx.execute(
          sql.raw(
            `INSERT INTO "${schema}"."public_job_discovery_sources" (id, provider, board, company) VALUES ('fixture', 'provider', 'board', 'company')`,
          ),
        );
        const inserted = await tx.execute(
          sql.raw(
            `INSERT INTO "${schema}"."public_job_discovery_jobs" (source_id, external_id, canonical_url, canonical_url_hash, title, company, location, work_mode, url, text) VALUES ('fixture', 'job-1', 'https://example.test/job', 'fixture-hash', 'Role', 'Company', 'Remote', 'remote', 'https://example.test/job', 'Public job text') RETURNING id`,
          ),
        );
        expect(inserted.rows).toHaveLength(1);
        const checks = await tx.execute(
          sql.raw(
            `SELECT conname FROM pg_constraint WHERE conrelid = '"${schema}"."public_job_discovery_jobs"'::regclass ORDER BY conname`,
          ),
        );
        expect(checks.rows.map((row) => row.conname)).toContain(
          'public_job_discovery_jobs_source_id_public_job_discovery_sources_id_fk'.slice(
            0,
            63,
          ),
        );
        const indexes = await tx.execute(
          sql.raw(
            `SELECT indexname FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = 'public_job_discovery_jobs'`,
          ),
        );
        expect(indexes.rows.map((row) => row.indexname)).toContain(
          'public_job_discovery_jobs_canonical_url_hash_unique',
        );
        await applyMigration(
          tx,
          await migrationFile('down/0031_durable_free_fit_review.sql'),
          schema,
        );
        const removedEntitlementColumns = await tx.execute(sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = 'users'
            AND column_name IN ('first_fit_review_used', 'first_fit_review_request_key', 'first_fit_review_opportunity_id')
        `);
        expect(removedEntitlementColumns.rows).toEqual([]);
        await applyMigration(
          tx,
          await migrationFile('down/0030_free_first_fit_review.sql'),
          schema,
        );
        const removedColumns = await tx.execute(sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = 'fit_reviews'
            AND column_name IN ('is_free', 'request_key')
        `);
        expect(removedColumns.rows).toEqual([]);
        const removedIndexes = await tx.execute(sql`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schema}
            AND indexname IN ('fit_reviews_one_free_per_user_unique', 'fit_reviews_user_request_key_unique')
        `);
        expect(removedIndexes.rows).toEqual([]);
        throw new Error('ROLLBACK_MIGRATION_VERIFICATION');
      })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === 'ROLLBACK_MIGRATION_VERIFICATION'
        )
          return;
        throw error;
      });
  }

  it('applies the full fresh migration history from 0000 through 0023', async () => {
    await verifyMigrationPath(false);
  }, 30_000);

  it('applies 0022 and 0023 when 0021 was skipped by an existing migration ledger', async () => {
    await verifyMigrationPath(true);
  }, 30_000);

  it('backfills sightings, re-applies migration 0032 safely, and reverses it', async () => {
    await database
      .transaction(async (tx) => {
        const schema = `migration_reversal_${randomUUID().replaceAll('-', '')}`;
        await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
        await tx.execute(
          sql`SET LOCAL search_path TO ${sql.identifier(schema)}`,
        );
        await applyJournal(tx, schema, false, true);
        await tx.execute(sql.raw(
          `INSERT INTO "${schema}"."public_job_discovery_sources" (id, provider, board, company) VALUES ('fixture', 'provider', 'board', 'company')`,
        ));
        await tx.execute(sql.raw(
          `INSERT INTO "${schema}"."public_job_discovery_jobs" (source_id, external_id, canonical_url, canonical_url_hash, title, company, location, work_mode, url, text, posted_at, first_seen_at, last_seen_at) VALUES ('fixture', 'job-1', 'https://example.test/job', 'sighting-hash', 'Role', 'Company', 'Remote', 'remote', 'https://example.test/job', 'Description', NULL, '2020-01-02T03:04:05Z', '2020-02-03T04:05:06Z')`,
        ));

        const up = await migrationFile('0032_discovery_catalog_state.sql');
        await applyMigration(tx, up, schema);
        const before = await tx.execute(sql.raw(
          `SELECT first_seen_at, last_seen_at FROM "${schema}"."discovery_job_sightings" WHERE canonical_url_hash = 'sighting-hash'`,
        ));
        expect(before.rows).toHaveLength(1);
        expect(new Date(before.rows[0].first_seen_at as string).toISOString()).toBe('2020-01-02T03:04:05.000Z');

        await applyMigration(tx, up, schema);
        const repeat = await tx.execute(sql.raw(
          `SELECT count(*)::int AS count FROM "${schema}"."discovery_job_sightings" WHERE canonical_url_hash = 'sighting-hash'`,
        ));
        expect(repeat.rows[0].count).toBe(1);

        await applyMigration(
          tx,
          await migrationFile('down/0032_discovery_catalog_state.sql'),
          schema,
        );
        const removed = await tx.execute(sql.raw(
          `SELECT to_regclass('"${schema}".discovery_job_sightings') AS sightings, to_regclass('"${schema}".discovery_sweeps') AS sweeps, to_regclass('"${schema}".discovery_collection_state') AS state`,
        ));
        expect(removed.rows[0]).toEqual({ sightings: null, sweeps: null, state: null });
        await applyMigration(tx, up, schema);
        const reapplied = await tx.execute(sql.raw(
          `SELECT count(*)::int AS count FROM "${schema}"."discovery_job_sightings" WHERE canonical_url_hash = 'sighting-hash'`,
        ));
        expect(reapplied.rows[0].count).toBe(1);
        throw new Error('ROLLBACK_MIGRATION_VERIFICATION');
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'ROLLBACK_MIGRATION_VERIFICATION') return;
        throw error;
      });
  }, 30_000);

  it('adds, reverses, reapplies, and safely repeats resume copy request keys', async () => {
    await database
      .transaction(async (tx) => {
        const schema = `migration_resume_request_key_${randomUUID().replaceAll('-', '')}`;
        await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
        await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}`);
        await applyJournal(tx, schema, false, false, false, true);

        const up = await migrationFile('0034_resume_copy_request_key.sql');
        const down = await migrationFile('down/0034_resume_copy_request_key.sql');
        const state = async () => tx.execute(sql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = 'resume_versions'
            AND column_name = 'request_key'
        `);
        const index = async () => tx.execute(sql`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schema} AND indexname = 'resume_versions_user_opportunity_request_key_unique'
        `);

        expect((await state()).rows).toEqual([]);
        expect((await index()).rows).toEqual([]);
        await applyMigration(tx, up, schema);
        expect((await state()).rows).toEqual([{ column_name: 'request_key' }]);
        expect((await index()).rows).toHaveLength(1);
        await applyMigration(tx, up, schema);
        expect((await state()).rows).toEqual([{ column_name: 'request_key' }]);
        expect((await index()).rows).toHaveLength(1);

        await applyMigration(tx, down, schema);
        expect((await state()).rows).toEqual([]);
        expect((await index()).rows).toEqual([]);
        await applyMigration(tx, up, schema);
        expect((await state()).rows).toEqual([{ column_name: 'request_key' }]);
        expect((await index()).rows).toHaveLength(1);
        throw new Error('ROLLBACK_MIGRATION_VERIFICATION');
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'ROLLBACK_MIGRATION_VERIFICATION') return;
        throw error;
      });
  }, 30_000);

  it('adds, reverses, reapplies, and safely repeats the fit review scorecard migration', async () => {
    await database
      .transaction(async (tx) => {
        const schema = `migration_scorecard_${randomUUID().replaceAll('-', '')}`;
        await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
        await tx.execute(
          sql`SET LOCAL search_path TO ${sql.identifier(schema)}`,
        );
        await applyJournal(tx, schema, false, false, true);

        // A row created before 0033 must survive the additive upgrade and keep
        // the new nullable fields empty until a scored review is written.
        const legacyUserId = randomUUID();
        const legacyJobId = randomUUID();
        const legacyOpportunityId = randomUUID();
        const legacyReviewId = randomUUID();
        await tx.execute(sql`
          INSERT INTO users (id, clerk_id)
          VALUES (${legacyUserId}, ${`migration-scorecard-${randomUUID()}`})
        `);
        await tx.execute(sql`
          INSERT INTO jobs (id, user_id, source, text_hash, text, title, company)
          VALUES (${legacyJobId}, ${legacyUserId}, 'paste', ${randomUUID()}, 'Role description', 'Role', 'Company')
        `);
        await tx.execute(sql`
          INSERT INTO opportunities (id, user_id, job_id)
          VALUES (${legacyOpportunityId}, ${legacyUserId}, ${legacyJobId})
        `);
        await tx.execute(sql`
          INSERT INTO fit_reviews (
            id, user_id, opportunity_id, verdict, strengths, gaps,
            unknowns, prompt_version, model
          ) VALUES (
            ${legacyReviewId}, ${legacyUserId}, ${legacyOpportunityId},
            'mixed', '[{"text":"Existing strength","fact_ids":[]}]'::jsonb,
            '["Existing gap"]'::jsonb, '["Existing unknown"]'::jsonb,
            'fit-review.v1', 'recorded-model'
          )
        `);

        const up = await migrationFile('0033_fit_review_scorecard.sql');
        const down = await migrationFile('down/0033_fit_review_scorecard.sql');
        const columnState = async () => tx.execute(sql`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = 'fit_reviews'
            AND column_name IN ('scorecard', 'requirements')
          ORDER BY column_name
        `);
        const expected = [
          { column_name: 'requirements', data_type: 'jsonb', is_nullable: 'YES' },
          { column_name: 'scorecard', data_type: 'jsonb', is_nullable: 'YES' },
        ];

        expect((await columnState()).rows).toEqual([]);
        await applyMigration(tx, up, schema);
        expect((await columnState()).rows).toEqual(expected);
        const upgraded = await tx.execute(sql`
          SELECT verdict, strengths, gaps, unknowns, prompt_version, model,
            scorecard, requirements
          FROM fit_reviews WHERE id = ${legacyReviewId}
        `);
        expect(upgraded.rows).toEqual([{
          verdict: 'mixed',
          strengths: [{ text: 'Existing strength', fact_ids: [] }],
          gaps: ['Existing gap'],
          unknowns: ['Existing unknown'],
          prompt_version: 'fit-review.v1',
          model: 'recorded-model',
          scorecard: null,
          requirements: null,
        }]);

        // IF NOT EXISTS keeps an interrupted/retried deploy safe.
        await applyMigration(tx, up, schema);
        expect((await columnState()).rows).toEqual(expected);

        await applyMigration(tx, down, schema);
        expect((await columnState()).rows).toEqual([]);
        const afterDown = await tx.execute(sql`
          SELECT verdict, strengths, gaps, unknowns, prompt_version, model
          FROM fit_reviews WHERE id = ${legacyReviewId}
        `);
        expect(afterDown.rows).toEqual([{
          verdict: 'mixed',
          strengths: [{ text: 'Existing strength', fact_ids: [] }],
          gaps: ['Existing gap'],
          unknowns: ['Existing unknown'],
          prompt_version: 'fit-review.v1',
          model: 'recorded-model',
        }]);

        await applyMigration(tx, up, schema);
        expect((await columnState()).rows).toEqual(expected);
        const afterReapply = await tx.execute(sql`
          SELECT scorecard, requirements
          FROM fit_reviews WHERE id = ${legacyReviewId}
        `);
        expect(afterReapply.rows).toEqual([{ scorecard: null, requirements: null }]);
        throw new Error('ROLLBACK_MIGRATION_VERIFICATION');
      })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === 'ROLLBACK_MIGRATION_VERIFICATION'
        )
          return;
        throw error;
      });
  }, 30_000);

  it('checks the applied deferred constraint and resume deletion behavior in a rolled-back transaction', async () => {
    await database
      .transaction(async (tx) => {
        const constraint = await tx.execute(sql`
        SELECT condeferrable, condeferred
        FROM pg_constraint
        WHERE conname = 'application_handoffs_resume_owner_fk'
          AND conrelid = 'public.application_handoffs'::regclass
      `);
        expect(constraint.rows[0]).toMatchObject({
          condeferrable: true,
          condeferred: true,
        });
        const userId = randomUUID();
        const opportunityId = randomUUID();
        const jobId = randomUUID();
        const resumeId = randomUUID();
        const handoffId = randomUUID();
        await tx.execute(sql`
        INSERT INTO users (id, clerk_id) VALUES (${userId}, ${`migration-check-${randomUUID()}`})
      `);
        await tx.execute(sql`
        INSERT INTO jobs (id, user_id, source, text_hash, text, title, company)
        VALUES (${jobId}, ${userId}, 'paste', ${randomUUID()}, 'Migration fixture role description', 'Role', 'Company')
      `);
        await tx.execute(sql`
        INSERT INTO opportunities (id, user_id, job_id)
        VALUES (${opportunityId}, ${userId}, ${jobId})
      `);
        await tx.execute(sql`
        INSERT INTO resume_versions (id, user_id, opportunity_id, content, version)
        VALUES (${resumeId}, ${userId}, ${opportunityId}, '{"name":"","contact":"","sections":[]}'::jsonb, 1)
      `);
        await tx.execute(sql`
        INSERT INTO application_handoffs (id, user_id, opportunity_id, resume_id, source)
        VALUES (${handoffId}, ${userId}, ${opportunityId}, ${resumeId}, 'employer_link')
      `);
        await tx.execute(
          sql`DELETE FROM resume_versions WHERE id = ${resumeId}`,
        );
        await tx.execute(
          sql`SET CONSTRAINTS application_handoffs_resume_owner_fk IMMEDIATE`,
        );
        const saved = await tx.execute(sql`
        SELECT resume_id FROM application_handoffs WHERE id = ${handoffId}
      `);
        expect(saved.rows[0].resume_id).toBeNull();
        throw new Error('ROLLBACK_MIGRATION_VERIFICATION');
      })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === 'ROLLBACK_MIGRATION_VERIFICATION'
        )
          return;
        throw error;
      });
  });
});
