import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PrivateStorage } from '@career-workspace/adapters/storage';
import {
  createDatabase,
  files,
  resumeVersions,
  users,
  type Database,
} from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJob } from './roles';
import { createTask } from './tasks';
import { runRevokedPdfCleanupTask } from './revoked-pdf-cleanup';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('revoked resume PDF cleanup', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  const clerkId = `revoked-pdf-cleanup-${randomUUID()}`;
  const objects = new Map<string, Uint8Array>();
  const failOnce = new Set<string>();
  const storage: PrivateStorage = {
    async put(key, contents) {
      objects.set(key, new Uint8Array(contents));
    },
    async get(key) {
      const contents = objects.get(key);
      return contents ? new Uint8Array(contents) : null;
    },
    async delete(key) {
      if (failOnce.delete(key)) throw new Error('recorded storage failure');
      objects.delete(key);
    },
  };

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
    const [user] = await database
      .insert(users)
      .values({ clerkId })
      .returning({ id: users.id });
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await database.delete(users).where(eq(users.id, userId));
    await pool?.end();
  });

  async function addFile(label: string) {
    const r2Key = `revoked-pdf-test/${randomUUID()}.pdf`;
    objects.set(r2Key, new TextEncoder().encode(label));
    const [file] = await database
      .insert(files)
      .values({
        userId,
        r2Key,
        kind: 'resume_pdf',
        originalName: `${label}.pdf`,
        contentType: 'application/pdf',
        size: label.length,
      })
      .returning();
    return file;
  }

  async function schedule(fileId: string) {
    return createTask(
      userId,
      'revoked_pdf_cleanup',
      `revoked-pdf-${fileId}`,
      { fileId },
      database,
    );
  }

  it('deletes a revoked PDF but preserves an unrelated current resume file', async () => {
    const revoked = await addFile('revoked');
    const current = await addFile('current');
    const { opportunity } = await createJob(
      userId,
      {
        title: 'Current resume role',
        company: `Cleanup ${randomUUID()}`,
        text: `This role covers clear writing, careful research, and teamwork ${randomUUID()}. `.repeat(3),
      },
      { database },
    );
    await database.insert(resumeVersions).values({
      userId,
      opportunityId: opportunity.id,
      version: 1,
      pdfFileId: current.id,
      content: { name: '', contact: '', sections: [] },
    });

    const task = await schedule(revoked.id);
    const completed = await runRevokedPdfCleanupTask(userId, task.id, {
      database,
      storage,
    });

    expect(completed.status).toBe('succeeded');
    expect(
      await database.select().from(files).where(eq(files.id, revoked.id)),
    ).toEqual([]);
    expect(
      await database.select().from(files).where(eq(files.id, current.id)),
    ).toHaveLength(1);
    expect(objects.has(revoked.r2Key)).toBe(false);
    expect(objects.has(current.r2Key)).toBe(true);

    const currentTask = await schedule(current.id);
    const preserved = await runRevokedPdfCleanupTask(userId, currentTask.id, {
      database,
      storage,
    });
    expect(preserved).toMatchObject({
      status: 'succeeded',
      output: { deleted: false, stillReferenced: true },
    });
    expect(objects.has(current.r2Key)).toBe(true);
  });

  it('leaves the file row intact after storage failure and succeeds on retry', async () => {
    const file = await addFile('retry');
    failOnce.add(file.r2Key);
    const task = await schedule(file.id);

    const failed = await runRevokedPdfCleanupTask(userId, task.id, {
      database,
      storage,
    });
    expect(failed).toMatchObject({ status: 'failed', error: 'FILE_CLEANUP_FAILED' });
    expect(
      await database.select().from(files).where(eq(files.id, file.id)),
    ).toHaveLength(1);
    expect(objects.has(file.r2Key)).toBe(true);

    const retried = await runRevokedPdfCleanupTask(userId, task.id, {
      database,
      storage,
    });
    expect(retried.status).toBe('succeeded');
    expect(
      await database.select().from(files).where(and(eq(files.id, file.id), eq(files.userId, userId))),
    ).toEqual([]);
    expect(objects.has(file.r2Key)).toBe(false);
  });
});
