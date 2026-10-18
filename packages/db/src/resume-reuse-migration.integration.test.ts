import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_TEST_URL;
const migrations = resolve(import.meta.dirname, '../migrations');
describe.skipIf(!url)('0035 CV reuse provenance migration', () => {
  const client = new pg.Client({ connectionString: url });
  beforeAll(async () => {
    if (new URL(url!).pathname !== '/career_workspace_test') throw new Error('Use career_workspace_test only.');
    await client.connect();
  });
  afterAll(async () => client.end());
  it('repairs only same-owner cross-role copies, preserves events and reverses/reapplies safely', async () => {
    await client.query('BEGIN');
    try {
      const schema = `reuse_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query('CREATE TABLE resume_versions (id uuid PRIMARY KEY, user_id uuid, opportunity_id uuid, restored_from_id uuid)');
      await client.query('CREATE TABLE events (user_id uuid, type text, data jsonb)');
      const [user, other, role, target, source, copy, restore, foreign] = Array.from({ length: 8 }, () => randomUUID());
      await client.query('INSERT INTO resume_versions VALUES ($1,$2,$3,NULL),($4,$2,$5,$1),($6,$2,$3,$1),($7,$8,$5,$1)', [source, user, role, copy, target, restore, foreign, other]);
      await client.query("INSERT INTO events VALUES ($1, 'resume.restored', $2),($1, 'resume.restored', $3)", [user, JSON.stringify({ resumeId: copy, version: 1 }), JSON.stringify({ resumeId: restore, version: 2 })]);
      const apply = async (name: string) => {
        const text = await readFile(resolve(migrations, name), 'utf8');
        for (const statement of text.split('--> statement-breakpoint').filter(part => part.trim())) await client.query(statement);
      };
      const up = '0035_resume_reuse_provenance.sql';
      const down = 'down/0035_resume_reuse_provenance.sql';
      await apply(up);
      await apply(up);
      const rows = (await client.query('SELECT * FROM resume_versions')).rows;
      expect(rows.find(row => row.id === copy)).toMatchObject({ reused_from_id: source, restored_from_id: null });
      expect(rows.find(row => row.id === restore)).toMatchObject({ reused_from_id: null, restored_from_id: source });
      expect(rows.find(row => row.id === foreign)).toMatchObject({ reused_from_id: null, restored_from_id: source });
      const events = (await client.query('SELECT * FROM events')).rows;
      expect(events.find(row => row.data.resumeId === copy)).toMatchObject({ type: 'resume.reused', data: { reusedFromId: source, version: 1 } });
      expect(events.find(row => row.data.resumeId === restore).type).toBe('resume.restored');
      await apply(down);
      await apply(down);
      expect((await client.query('SELECT restored_from_id FROM resume_versions WHERE id=$1', [copy])).rows[0].restored_from_id).toBe(source);
      expect((await client.query("SELECT count(*)::int AS n FROM events WHERE type='resume.reused'")).rows[0].n).toBe(0);
      await apply(up);
      expect((await client.query('SELECT reused_from_id, restored_from_id FROM resume_versions WHERE id=$1', [copy])).rows[0]).toEqual({ reused_from_id: source, restored_from_id: null });
    } finally { await client.query('ROLLBACK'); }
  });
});

it('keeps migration 0035 after 0034 and its snapshot linked', async () => {
  const journalText = await readFile(resolve(migrations, 'meta/_journal.json'), 'utf8');
  const entries = JSON.parse(journalText).entries.filter((entry: { idx: number }) => entry.idx <= 35);
  expect(journalText.endsWith('\n')).toBe(true);
  expect(entries.slice(-2).map((entry: { idx: number }) => entry.idx)).toEqual([34, 35]);
  expect(entries.at(-1).when).toBeGreaterThan(entries.at(-2).when);
  const previous = JSON.parse(await readFile(resolve(migrations, 'meta/0034_snapshot.json'), 'utf8'));
  const current = JSON.parse(await readFile(resolve(migrations, 'meta/0035_snapshot.json'), 'utf8'));
  expect(current.prevId).toBe(previous.id);
  expect(current.tables['public.resume_versions'].columns.reused_from_id).toMatchObject({ type: 'uuid', notNull: false });
});
