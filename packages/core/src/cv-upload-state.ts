import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  files,
  getDatabase,
  profileFacts,
  tasks,
  users,
  type Database,
} from '@career-workspace/db';
import { ApiError } from './api';
import { checkRateLimit } from './rate-limit';

export type CvUploadStateName =
  'reading' | 'ready' | 'confirmed' | 'failed' | 'empty';

export async function getCvUploadState(
  userId: string,
  fileId?: string,
  database: Database = getDatabase(),
) {
  const [file] = await database
    .select({
      id: files.id,
      originalName: files.originalName,
      contentType: files.contentType,
      size: files.size,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        eq(files.kind, 'cv_upload'),
        ...(fileId ? [eq(files.id, fileId)] : []),
      ),
    )
    .orderBy(desc(files.createdAt))
    .limit(1);
  if (!file)
    return {
      file: null,
      task: null,
      facts: [],
      state: 'empty' as const,
      factCount: 0,
      approvedCount: 0,
    };

  const matchingTasks = await database
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.kind, 'cv_extract'),
        sql`${tasks.input}->>'fileId' = ${file.id}`,
      ),
    )
    .orderBy(desc(tasks.createdAt), desc(tasks.updatedAt));
  const task =
    matchingTasks.find((candidate) =>
      ['queued', 'running'].includes(candidate.status),
    ) ??
    matchingTasks[0] ??
    null;
  const matchedFactIds = matchingTasks.flatMap((candidate) => {
    const output = candidate.output;
    if (!output || typeof output !== 'object' || Array.isArray(output))
      return [];
    const ids = (output as { duplicateFactIds?: unknown }).duplicateFactIds;
    if (!Array.isArray(ids)) return [];
    return ids.filter(
      (id): id is string =>
        typeof id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        ),
    );
  });
  const factScope = matchedFactIds.length
    ? or(
        eq(profileFacts.sourceFileId, file.id),
        inArray(profileFacts.id, matchedFactIds),
      )
    : eq(profileFacts.sourceFileId, file.id);
  const ownedFacts = await database
    .select()
    .from(profileFacts)
    .where(
      and(
        eq(profileFacts.userId, userId),
        inArray(profileFacts.status, ['proposed', 'approved']),
        factScope,
      ),
    );
  const approvedCount = ownedFacts.filter(
    (fact) => fact.status === 'approved',
  ).length;
  const factCount = ownedFacts.length;
  const hasProposedFacts = factCount > approvedCount;
  const state: CvUploadStateName =
    task && ['queued', 'running'].includes(task.status)
      ? 'reading'
      : hasProposedFacts
        ? 'ready'
        : approvedCount > 0
          ? 'confirmed'
          : task?.status === 'failed'
            ? 'failed'
            : 'empty';
  return { file, task, facts: ownedFacts, state, factCount, approvedCount };
}

export async function createCvReadTask(
  userId: string,
  fileId: string,
  options: { retry?: boolean; database?: Database } = {},
) {
  const database = options.database ?? getDatabase();
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
    if (user.deletionRequestedAt)
      throw new ApiError(
        403,
        'ACCOUNT_DELETION_PENDING',
        'Account deletion is in progress.',
      );

    const [file] = await tx
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          eq(files.userId, userId),
          eq(files.kind, 'cv_upload'),
        ),
      )
      .for('update');
    if (!file) throw new ApiError(404, 'NOT_FOUND', 'CV upload not found.');

    const history = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.kind, 'cv_extract'),
          sql`${tasks.input}->>'fileId' = ${file.id}`,
        ),
      )
      .orderBy(desc(tasks.createdAt), desc(tasks.updatedAt))
      .for('update');
    const pending = history.find((task) =>
      ['queued', 'running'].includes(task.status),
    );
    if (pending)
      return { task: pending, shouldStart: pending.status === 'queued' };

    const successful = history.find((task) => task.status === 'succeeded');
    if (successful && !options.retry)
      return { task: successful, shouldStart: false };

    if (options.retry) {
      // Each "Read again" starts a paid AI read, so cap it separately.
      const limit = await checkRateLimit(
        userId,
        'cv_read_again',
        { limit: 5, windowMs: 3_600_000 },
        tx,
      );
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Try reading this CV again in an hour. Your saved facts are still available.',
        );
    }

    const idempotencyKey = `task:${userId}:cv:${file.id}:retry:${randomUUID()}`;
    const [task] = await tx
      .insert(tasks)
      .values({
        userId,
        kind: 'cv_extract',
        input: { fileId: file.id },
        idempotencyKey,
      })
      .returning();
    return { task, shouldStart: true };
  });
}
