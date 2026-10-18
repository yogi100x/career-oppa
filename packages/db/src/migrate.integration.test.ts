import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from './migrate';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;
const migrations = resolve(import.meta.dirname, '../migrations');
type JournalEntry = { idx: number; when: number; tag: string };

async function journal() {
  return JSON.parse(
    await readFile(resolve(migrations, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
}

async function applyInSchema(
  client: pg.Client,
  contents: string,
  schema: string,
) {
  const statements = contents
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => statement.replaceAll('"public".', `"${schema}".`));
  for (const statement of statements) await client.query(statement);
}

integration('custom migration runner', () => {
  const schemas: string[] = [];
  let setupClient: pg.Client;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    setupClient = new pg.Client({ connectionString: databaseUrl });
    await setupClient.connect();
  });

  afterAll(async () => {
    for (const schema of schemas)
      await setupClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await setupClient.end();
  });

  async function newSchema() {
    const schema = `runner_${randomUUID().replaceAll('-', '')}`;
    schemas.push(schema);
    schemas.push(`${schema}_drizzle`);
    await setupClient.query(`CREATE SCHEMA "${schema}"`);
    return schema;
  }

  async function expectLatestSchema(schema: string) {
    const columns = await setupClient.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
      [schema],
    );
    const present = new Set(
      columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
    );
    for (const column of [
      'resume_versions.reused_from_id',
      'files.content_hash',
      'users.first_fit_review_used',
      'users.first_fit_review_request_key',
      'users.first_fit_review_opportunity_id',
      'fit_reviews.is_free',
      'fit_reviews.request_key',
      'fit_reviews.scorecard',
      'fit_reviews.requirements',
      'public_job_discovery_sources.catalog_active',
      'public_job_discovery_sources.verified_at',
      'public_job_discovery_sources.failure_count',
      'public_job_discovery_sources.dead_until_at',
      'public_job_discovery_sources.next_retry_at',
      'discovery_collection_state.current_sweep_key',
      'discovery_sweeps.lease_until',
      'discovery_job_sightings.last_seen_at',
    ])
      expect(present.has(column), column).toBe(true);
  }

  it('runs all migrations on a clean schema and is a no-op on the second run', async () => {
    const schema = await newSchema();
    const { entries } = await journal();
    expect(await migrate(databaseUrl!, schema)).toEqual(
      entries.map((entry) => entry.tag),
    );
    expect(await migrate(databaseUrl!, schema)).toEqual([]);
    await expectLatestSchema(schema);
  }, 30_000);

  it('applies 0032 through 0036 when 0030 and 0031 already exist in the migration ledger', async () => {
    const schema = await newSchema();
    await setupClient.query(`SET search_path TO "${schema}"`);
    const { entries } = await journal();
    for (const entry of entries.filter((item) => item.idx <= 31)) {
      const contents = await readFile(
        resolve(migrations, `${entry.tag}.sql`),
        'utf8',
      );
      await applyInSchema(setupClient, contents, schema);
    }
    await setupClient.query(`CREATE SCHEMA "${schema}_drizzle"`);
    await setupClient.query(`CREATE TABLE "${schema}_drizzle".__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`);
    for (const entry of entries.filter((item) => item.idx <= 31)) {
      const contents = await readFile(
        resolve(migrations, `${entry.tag}.sql`),
        'utf8',
      );
      await setupClient.query(
        `INSERT INTO "${schema}_drizzle".__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [createHash('sha256').update(contents).digest('hex'), entry.when],
      );
    }
    await setupClient.query('SET search_path TO public');

    expect(await migrate(databaseUrl!, schema)).toEqual([
      '0032_discovery_catalog_state',
      '0033_fit_review_scorecard',
      '0034_resume_copy_request_key',
      '0035_resume_reuse_provenance',
      '0036_cv_upload_content_hash',
    ]);
    await expectLatestSchema(schema);
  }, 30_000);
});
