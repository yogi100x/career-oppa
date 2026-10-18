import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_TEST_URL;
const migrations = resolve(import.meta.dirname, '../migrations');
const integration = url ? describe : describe.skip;

integration('0036 CV upload content hash migration', () => {
  const client = new pg.Client({ connectionString: url });

  beforeAll(async () => {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    await client.connect();
  });

  afterAll(async () => client.end());

  it('keeps legacy rows null and can roll back and reapply repeatedly', async () => {
    await client.query('BEGIN');
    try {
      const schema = `cv_hash_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(
        'CREATE TABLE files (id uuid PRIMARY KEY, user_id uuid NOT NULL, kind text NOT NULL)',
      );
      const legacyId = randomUUID();
      await client.query(
        "INSERT INTO files (id, user_id, kind) VALUES ($1, $2, 'cv_upload')",
        [legacyId, randomUUID()],
      );

      const apply = async (name: string) => {
        const text = await readFile(resolve(migrations, name), 'utf8');
        for (const statement of text
          .split('--> statement-breakpoint')
          .filter((part) => part.trim()))
          await client.query(statement);
      };
      const up = '0036_cv_upload_content_hash.sql';
      const down = 'down/0036_cv_upload_content_hash.sql';

      await apply(up);
      await apply(up);
      expect(
        (
          await client.query('SELECT content_hash FROM files WHERE id = $1', [
            legacyId,
          ])
        ).rows[0].content_hash,
      ).toBeNull();
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND indexname = 'files_user_kind_hash_unique'",
            [schema],
          )
        ).rows[0].n,
      ).toBe(1);

      await apply(down);
      await apply(down);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'files' AND column_name = 'content_hash'",
            [schema],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await client.query('SELECT id FROM files WHERE id = $1', [legacyId]))
          .rows,
      ).toHaveLength(1);

      await apply(up);
      expect(
        (
          await client.query('SELECT content_hash FROM files WHERE id = $1', [
            legacyId,
          ])
        ).rows[0].content_hash,
      ).toBeNull();
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

it('keeps migration 0036 after 0035 and its snapshot linked', async () => {
  const journalText = await readFile(
    resolve(migrations, 'meta/_journal.json'),
    'utf8',
  );
  const entries = JSON.parse(journalText).entries;
  expect(journalText.endsWith('\n')).toBe(true);
  expect(entries.slice(-2).map((entry: { idx: number }) => entry.idx)).toEqual([
    35, 36,
  ]);
  expect(entries.at(-1).when).toBeGreaterThan(entries.at(-2).when);
  const previous = JSON.parse(
    await readFile(resolve(migrations, 'meta/0035_snapshot.json'), 'utf8'),
  );
  const current = JSON.parse(
    await readFile(resolve(migrations, 'meta/0036_snapshot.json'), 'utf8'),
  );
  expect(current.prevId).toBe(previous.id);
  expect(current.tables['public.files'].columns.content_hash).toMatchObject({
    type: 'text',
    notNull: false,
  });
});
