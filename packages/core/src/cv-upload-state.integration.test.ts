import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  createDatabase,
  files,
  profileFacts,
  tasks,
  users,
  type Database,
} from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCvReadTask, getCvUploadState } from './cv-upload-state';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('CV upload reading state', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  let otherUserId: string;
  let fileId: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test') {
      throw new Error('Use career_workspace_test only.');
    }
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
    const [user, otherUser] = await database
      .insert(users)
      .values([
        { clerkId: `cv-state-${randomUUID()}` },
        { clerkId: `cv-state-other-${randomUUID()}` },
      ])
      .returning({ id: users.id });
    userId = user.id;
    otherUserId = otherUser.id;
    const [file] = await database
      .insert(files)
      .values({
        userId,
        r2Key: `cv-state/${randomUUID()}`,
        kind: 'cv_upload',
        originalName: 'candidate.pdf',
        contentType: 'application/pdf',
        size: 1024,
      })
      .returning({ id: files.id });
    fileId = file.id;
  });

  afterAll(async () => {
    if (userId && otherUserId) {
      await database.delete(users).where(eq(users.id, userId));
      await database.delete(users).where(eq(users.id, otherUserId));
    }
    await pool?.end();
  });

  it('reports owned extracted facts and follows reading, ready, and confirmed precedence', async () => {
    const first = await createCvReadTask(userId, fileId, { database });
    expect(first.shouldStart).toBe(true);
    expect(await createCvReadTask(userId, fileId, { database })).toMatchObject({
      task: { id: first.task.id },
      shouldStart: true,
    });
    expect((await getCvUploadState(userId, fileId, database)).state).toBe(
      'reading',
    );

    await database
      .update(tasks)
      .set({ status: 'succeeded' })
      .where(eq(tasks.id, first.task.id));
    const [proposed] = await database
      .insert(profileFacts)
      .values({
        userId,
        kind: 'experience',
        text: 'Built a customer portal',
        source: 'cv',
        status: 'proposed',
        sourceFileId: fileId,
      })
      .returning();
    expect(await getCvUploadState(userId, fileId, database)).toMatchObject({
      state: 'ready',
      factCount: 1,
      approvedCount: 0,
      facts: [{ id: proposed.id, sourceFileId: fileId }],
    });

    await database
      .update(profileFacts)
      .set({ status: 'approved' })
      .where(eq(profileFacts.id, proposed.id));
    expect(await getCvUploadState(userId, fileId, database)).toMatchObject({
      state: 'confirmed',
      factCount: 1,
      approvedCount: 1,
    });
  });

  it('reuses any prior success unless retry is explicit and starts a fresh task after failure', async () => {
    const [secondFile] = await database
      .insert(files)
      .values({
        userId,
        r2Key: `cv-state/${randomUUID()}`,
        kind: 'cv_upload',
        originalName: 'second-candidate.pdf',
        contentType: 'application/pdf',
        size: 1024,
      })
      .returning({ id: files.id });
    const firstAttempt = await createCvReadTask(userId, secondFile.id, {
      database,
    });
    await database
      .update(tasks)
      .set({ status: 'succeeded' })
      .where(eq(tasks.id, firstAttempt.task.id));
    const retryAttempt = await createCvReadTask(userId, secondFile.id, {
      database,
      retry: true,
    });
    await database
      .update(tasks)
      .set({ status: 'failed' })
      .where(eq(tasks.id, retryAttempt.task.id));
    const history = await database
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.kind, 'cv_extract')));
    const latestFailure = history.find((task) => task.status === 'failed');
    expect(latestFailure).toBeDefined();
    expect(
      await createCvReadTask(userId, secondFile.id, { database }),
    ).toMatchObject({ task: { id: firstAttempt.task.id }, shouldStart: false });
    const retried = await createCvReadTask(userId, secondFile.id, {
      database,
      retry: true,
    });
    expect(retried.shouldStart).toBe(true);
    expect(retried.task.id).not.toBe(retryAttempt.task.id);
  });

  it('limits Read again to five fresh reads an hour', async () => {
    const [user] = await database
      .insert(users)
      .values({ clerkId: `cv-state-limit-${randomUUID()}` })
      .returning({ id: users.id });
    try {
      const [file] = await database
        .insert(files)
        .values({
          userId: user.id,
          r2Key: `cv-state/${randomUUID()}`,
          kind: 'cv_upload',
          originalName: 'limit.pdf',
          contentType: 'application/pdf',
          size: 1024,
        })
        .returning({ id: files.id });
      const first = await createCvReadTask(user.id, file.id, { database });
      await database
        .update(tasks)
        .set({ status: 'succeeded' })
        .where(eq(tasks.id, first.task.id));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const retried = await createCvReadTask(user.id, file.id, {
          database,
          retry: true,
        });
        expect(retried.shouldStart).toBe(true);
        await database
          .update(tasks)
          .set({ status: 'failed' })
          .where(eq(tasks.id, retried.task.id));
      }
      await expect(
        createCvReadTask(user.id, file.id, { database, retry: true }),
      ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
      const history = await database
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, user.id), eq(tasks.kind, 'cv_extract')));
      expect(history).toHaveLength(6);
    } finally {
      await database.delete(users).where(eq(users.id, user.id));
    }
  });

  it('does not expose or retry another user’s CV', async () => {
    expect(await getCvUploadState(otherUserId, fileId, database)).toMatchObject(
      {
        file: null,
        facts: [],
        state: 'empty',
      },
    );
    await expect(
      createCvReadTask(otherUserId, fileId, { database }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('restores proposed matches from older uploads without exposing rejected or another user’s facts', async () => {
    const [updatedFile] = await database
      .insert(files)
      .values({
        userId,
        r2Key: `cv-state/${randomUUID()}`,
        kind: 'cv_upload',
        originalName: 'updated-candidate.pdf',
        contentType: 'application/pdf',
        size: 2048,
      })
      .returning({ id: files.id });
    const [olderProposal, rejectedFact, otherUsersFact, directFact] =
      await database
        .insert(profileFacts)
        .values([
          {
            userId,
            kind: 'skill',
            text: 'PostgreSQL',
            source: 'cv',
            status: 'proposed',
            sourceFileId: fileId,
          },
          {
            userId,
            kind: 'skill',
            text: 'Old rejected skill',
            source: 'cv',
            status: 'rejected',
            sourceFileId: fileId,
          },
          {
            userId: otherUserId,
            kind: 'skill',
            text: 'Another user skill',
            source: 'cv',
            status: 'proposed',
            sourceFileId: null,
          },
          {
            userId,
            kind: 'experience',
            text: 'Built a new service',
            source: 'cv',
            status: 'proposed',
            sourceFileId: updatedFile.id,
          },
        ])
        .returning();
    const extraction = await createCvReadTask(userId, updatedFile.id, {
      database,
    });
    await database
      .update(tasks)
      .set({
        status: 'succeeded',
        output: {
          newFactCount: 1,
          duplicateFactCount: 2,
          factIds: [directFact.id],
          duplicateFactIds: [
            olderProposal.id,
            rejectedFact.id,
            otherUsersFact.id,
          ],
        },
      })
      .where(eq(tasks.id, extraction.task.id));

    const state = await getCvUploadState(userId, updatedFile.id, database);
    expect(state).toMatchObject({
      state: 'ready',
      factCount: 2,
      approvedCount: 0,
    });
    expect(state.facts.map((fact) => fact.id).sort()).toEqual(
      [olderProposal.id, directFact.id].sort(),
    );
  });
});
