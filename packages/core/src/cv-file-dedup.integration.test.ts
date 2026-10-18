import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  files,
  rateLimits,
  users,
  type Database,
} from '@career-workspace/db';
import type { PrivateStorage } from '@career-workspace/adapters/storage';
import { eq } from 'drizzle-orm';
import { createUserFile } from './files';
import { getCvUploadState } from './cv-upload-state';

const url = process.env.DATABASE_TEST_URL;
const integration = url ? describe : describe.skip;

integration('CV file upload deduplication', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  const clerkIds: string[] = [];

  beforeAll(async () => {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    ({ database, pool } = createDatabase(url!));
  });

  afterAll(async () => {
    for (const clerkId of clerkIds)
      await database.delete(users).where(eq(users.clerkId, clerkId));
    await pool.end();
  });

  async function makeUser() {
    const clerkId = `cv-file-dedup-${randomUUID()}`;
    clerkIds.push(clerkId);
    const [user] = await database.insert(users).values({ clerkId }).returning();
    return user;
  }

  function fakePrivateStorage(): PrivateStorage & {
    content: Map<string, Uint8Array>;
  } {
    const content = new Map<string, Uint8Array>();
    return {
      content,
      async put(key, value) {
        content.set(key, value);
      },
      async get(key) {
        return content.get(key) ?? null;
      },
      async delete(key) {
        content.delete(key);
      },
    };
  }

  const input = (contents: Uint8Array, originalName = 'cv.pdf') => ({
    kind: 'cv_upload' as const,
    originalName,
    contents,
  });

  it('reuses one file for concurrent and repeated uploads of the same bytes', async () => {
    const user = await makeUser();
    const storage = fakePrivateStorage();
    const contents = new TextEncoder().encode('%PDF-1.4\nshared CV bytes');

    const [first, concurrent] = await Promise.all([
      createUserFile(user.id, input(contents, 'first.pdf'), {
        database,
        storage,
      }),
      createUserFile(user.id, input(contents, 'second.pdf'), {
        database,
        storage,
      }),
    ]);
    const repeated = await createUserFile(user.id, input(contents), {
      database,
      storage,
    });

    expect(first.id).toBe(concurrent.id);
    expect(concurrent.duplicate).toBe(true);
    expect(repeated.id).toBe(first.id);
    expect(repeated.duplicate).toBe(true);
    expect(storage.content.size).toBe(1);
    expect(
      await database.select().from(files).where(eq(files.userId, user.id)),
    ).toHaveLength(1);
    const [limit] = await database
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.userId, user.id));
    expect(limit).toMatchObject({ actionKey: 'cv_upload', count: 1 });
  });

  it('makes a repeat upload of an older CV the latest CV again', async () => {
    const user = await makeUser();
    const storage = fakePrivateStorage();
    const first = new TextEncoder().encode('%PDF-1.4\nCV A');
    const second = new TextEncoder().encode('%PDF-1.4\nCV B');
    const a = await createUserFile(user.id, input(first, 'a.pdf'), {
      database,
      storage,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    await createUserFile(user.id, input(second, 'b.pdf'), {
      database,
      storage,
      now: new Date('2026-01-02T00:00:00Z'),
    });
    const again = await createUserFile(user.id, input(first, 'a.pdf'), {
      database,
      storage,
      now: new Date('2026-01-03T00:00:00Z'),
    });

    expect(again).toMatchObject({ id: a.id, duplicate: true });
    const latest = await getCvUploadState(user.id, undefined, database);
    expect(latest.file?.id).toBe(a.id);
  });

  it('keeps identical CVs separate for different users', async () => {
    const firstUser = await makeUser();
    const secondUser = await makeUser();
    const storage = fakePrivateStorage();
    const contents = new TextEncoder().encode(
      '%PDF-1.4\nsame bytes, separate owners',
    );

    const first = await createUserFile(firstUser.id, input(contents), {
      database,
      storage,
    });
    const second = await createUserFile(secondUser.id, input(contents), {
      database,
      storage,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.duplicate).toBeUndefined();
    expect(storage.content.size).toBe(2);
  });

  it('finds a matching older CV without a hash and fills in its hash', async () => {
    const user = await makeUser();
    const storage = fakePrivateStorage();
    const contents = new TextEncoder().encode('%PDF-1.4\nlegacy CV bytes');
    const key = `files/legacy-${randomUUID()}.blob`;
    storage.content.set(key, contents);
    const [legacy] = await database
      .insert(files)
      .values({
        userId: user.id,
        r2Key: key,
        kind: 'cv_upload',
        originalName: 'old-name.pdf',
        contentType: 'application/pdf',
        size: contents.byteLength,
      })
      .returning();

    const reused = await createUserFile(
      user.id,
      input(contents, 'new-name.pdf'),
      {
        database,
        storage,
      },
    );
    const [backfilled] = await database
      .select()
      .from(files)
      .where(eq(files.id, legacy.id));

    expect(reused.id).toBe(legacy.id);
    expect(reused.duplicate).toBe(true);
    expect(backfilled.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storage.content.size).toBe(1);
  });

  it('does not count a reused upload toward the hourly new-upload limit', async () => {
    const user = await makeUser();
    const storage = fakePrivateStorage();
    const contents = Array.from({ length: 10 }, (_, index) =>
      new TextEncoder().encode(`%PDF-1.4\nunique CV ${index}`),
    );

    for (const bytes of contents)
      await createUserFile(user.id, input(bytes), { database, storage });
    const duplicate = await createUserFile(user.id, input(contents[0]), {
      database,
      storage,
    });

    expect(duplicate.duplicate).toBe(true);
    const [limit] = await database
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.userId, user.id));
    expect(limit).toMatchObject({ actionKey: 'cv_upload', count: 10 });
    await expect(
      createUserFile(
        user.id,
        input(new TextEncoder().encode('%PDF-1.4\nnew eleventh CV')),
        { database, storage },
      ),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(storage.content.size).toBe(10);
  });
});
