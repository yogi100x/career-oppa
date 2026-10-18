import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  files,
  getDatabase,
  resumeVersions,
  tasks,
  type Database,
} from '@career-workspace/db';
import {
  getPrivateStorage,
  type PrivateStorage,
} from '@career-workspace/adapters/storage';
import { ApiError } from './api';
import { getTask } from './tasks';

const FILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REVOKED_PDF_CLEANUP_KIND = 'revoked_pdf_cleanup';

type CleanupOptions = {
  database?: Database;
  storage?: PrivateStorage;
};

/** Plain idempotent task body shared by Workflow and post-commit best effort. */
export async function runRevokedPdfCleanupTask(
  userId: string,
  taskId: string,
  options: CleanupOptions = {},
) {
  const database = options.database ?? getDatabase();
  const task = await getTask(userId, taskId, database);
  if (task.kind !== REVOKED_PDF_CLEANUP_KIND)
    throw new ApiError(400, 'INVALID_INPUT', 'This is not a PDF cleanup task.');
  if (task.status === 'succeeded') return task;

  return database.transaction(async (tx) => {
    const [lockedTask] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
      .for('update');
    if (!lockedTask) throw new ApiError(404, 'NOT_FOUND', 'Task not found.');
    if (lockedTask.kind !== REVOKED_PDF_CLEANUP_KIND)
      throw new ApiError(400, 'INVALID_INPUT', 'This is not a PDF cleanup task.');
    if (lockedTask.status === 'succeeded') return lockedTask;

    const [running] = await tx
      .update(tasks)
      .set({
        status: 'running',
        attempts: sql`${tasks.attempts} + 1`,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))
      .returning();
    const input = lockedTask.input as { fileId?: unknown };
    let output: Record<string, unknown>;
    let errorCode: string | null = null;
    if (typeof input.fileId !== 'string' || !FILE_ID_PATTERN.test(input.fileId)) {
      errorCode = 'INVALID_TASK_INPUT';
      output = {};
    } else {
      const [file] = await tx
        .select({ id: files.id, r2Key: files.r2Key, kind: files.kind })
        .from(files)
        .where(and(eq(files.id, input.fileId), eq(files.userId, userId)))
        .for('update');
      if (!file) {
        output = { deleted: false, alreadyMissing: true };
      } else if (file.kind !== 'resume_pdf') {
        errorCode = 'FILE_KIND_MISMATCH';
        output = {};
      } else {
        const [reference] = await tx
          .select({ id: resumeVersions.id })
          .from(resumeVersions)
          .where(
            and(
              eq(resumeVersions.userId, userId),
              eq(resumeVersions.pdfFileId, file.id),
            ),
          )
          .limit(1);
        if (reference) {
          output = { deleted: false, stillReferenced: true };
        } else {
          try {
            const storage = options.storage ?? getPrivateStorage();
            // Holding the file row lock prevents a new resume FK reference
            // until deletion commits. If this transaction rolls back after
            // storage deletion, retrying storage.delete is safe and idempotent.
            await storage.delete(file.r2Key);
            await tx
              .delete(files)
              .where(and(eq(files.id, file.id), eq(files.userId, userId)));
            output = { deleted: true };
          } catch {
            errorCode = 'FILE_CLEANUP_FAILED';
            output = {};
          }
        }
      }
    }

    const [finished] = await tx
      .update(tasks)
      .set({
        status: errorCode ? 'failed' : 'succeeded',
        output,
        error: errorCode,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, running.id))
      .returning();
    return finished;
  });
}

/** Runs queued cleanup work after the profile transaction has committed. */
export async function runPendingRevokedPdfCleanup(
  userId: string,
  options: CleanupOptions = {},
) {
  const database = options.database ?? getDatabase();
  const pending = await database
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.kind, REVOKED_PDF_CLEANUP_KIND),
        inArray(tasks.status, ['queued']),
      ),
    );
  const results = [];
  for (const task of pending)
    results.push(await runRevokedPdfCleanupTask(userId, task.id, options));
  return results;
}
