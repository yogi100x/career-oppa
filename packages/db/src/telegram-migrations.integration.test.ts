import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pg from 'pg';

const connectionString = process.env.DATABASE_TEST_URL;
(connectionString ? describe : describe.skip)(
  'Telegram migration rollback',
  () => {
    it('can apply each migration twice, roll back twice and recreate in an isolated schema', async () => {
      if (new URL(connectionString!).pathname !== '/career_workspace_test')
        throw new Error('Use the test database only.');
      const pool = new pg.Pool({ connectionString });
      const client = await pool.connect();
      const schema = `telegram_migration_${randomUUID().replaceAll('-', '')}`;
      const base = new URL('../migrations/', import.meta.url);
      const up = await Promise.all(
        [
          '0027_telegram_links.sql',
          '0028_telegram_sdk_state.sql',
          '0029_telegram_unlinked_rate_limits.sql',
        ].map((file) => readFile(new URL(file, base), 'utf8')),
      );
      const down = await Promise.all(
        [
          'down/0029_telegram_unlinked_rate_limits.sql',
          'down/0028_telegram_sdk_state.sql',
          'down/0027_telegram_links.sql',
        ].map((file) => readFile(new URL(file, base), 'utf8')),
      );
      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await client.query('CREATE TABLE users (id uuid PRIMARY KEY)');
        await client.query(`CREATE TABLE rate_limits (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid REFERENCES users(id) ON DELETE CASCADE NOT NULL,
          action_key text NOT NULL,
          window_start timestamptz NOT NULL DEFAULT now(),
          count integer NOT NULL DEFAULT 1,
          CONSTRAINT rate_limits_user_action_unique UNIQUE (user_id, action_key)
        )`);
        for (let pass = 0; pass < 2; pass++)
          for (const migration of up) await client.query(migration);
        const count = () =>
          client.query(
            'SELECT count(*)::int AS total FROM information_schema.tables WHERE table_schema = $1 AND table_name <> $2',
            [schema, 'users'],
          );
        expect((await count()).rows[0].total).toBe(8);
        await client.query(`INSERT INTO rate_limits
          (external_subject, action_key) VALUES ('telegram:42', 'telegram_unlinked_reply')`);
        for (let pass = 0; pass < 2; pass++)
          for (const migration of down) await client.query(migration);
        expect((await count()).rows[0].total).toBe(1);
        for (const migration of up) await client.query(migration);
        expect((await count()).rows[0].total).toBe(8);
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await pool.end();
      }
    });
  },
);
