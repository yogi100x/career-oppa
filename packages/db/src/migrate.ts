import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { getPendingMigrations } from './migration-plan';

type Journal = { entries: Array<{ idx: number; when: number; tag: string }> };
const migrationDir = resolve(import.meta.dirname, '../migrations');

export async function migrate(
  databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/career_workspace',
  isolatedSchema?: string,
) {
  if (isolatedSchema) {
    if (new URL(databaseUrl).pathname !== '/career_workspace_test')
      throw new Error('Isolated migration schemas require career_workspace_test.');
    if (!/^[a-z][a-z0-9_]*$/.test(isolatedSchema) || isolatedSchema.length >= 55)
      throw new Error('Invalid isolated migration schema.');
  }
  const journal = JSON.parse(
    await readFile(resolve(migrationDir, 'meta/_journal.json'), 'utf8'),
  ) as Journal;
  const client = new Client({ connectionString: databaseUrl });
  const ledgerSchema = isolatedSchema ? `${isolatedSchema}_drizzle` : 'drizzle';
  await client.connect();
  try {
    if (isolatedSchema) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${isolatedSchema}"`);
      await client.query(`SET search_path TO "${isolatedSchema}"`);
    }
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('career_workspace'), hashtext('drizzle_migrations'))");
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${ledgerSchema}"`);
    await client.query(`CREATE TABLE IF NOT EXISTS "${ledgerSchema}".__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
    const applied = await client.query<{ created_at: string | null }>(
      `SELECT created_at FROM "${ledgerSchema}".__drizzle_migrations`,
    );
    const appliedTimestamps = new Set(
      applied.rows
        .filter((row) => row.created_at !== null)
        .map((row) => Number(row.created_at))
        .filter(Number.isFinite),
    );
    const pending = getPendingMigrations(journal.entries, appliedTimestamps);
    for (const entry of pending) {
      const contents = await readFile(resolve(migrationDir, `${entry.tag}.sql`), 'utf8');
      for (const statement of contents
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) =>
          isolatedSchema
            ? value.replaceAll('"public".', `"${isolatedSchema}".`)
            : value,
        )) {
        await client.query(statement);
      }
      const hash = createHash('sha256').update(contents).digest('hex');
      await client.query(
        `INSERT INTO "${ledgerSchema}".__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [hash, entry.when],
      );
    }
    await client.query('COMMIT');
    return pending.map((entry) => entry.tag);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  migrate()
    .then((tags) => console.info(tags.length ? `Applied migrations: ${tags.join(', ')}` : 'Database is up to date.'))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Database migration failed.');
      process.exitCode = 1;
    });
}
