import { and, eq } from 'drizzle-orm';
import {
  getDatabase,
  profileFacts,
  tasks,
  users,
  type Database,
} from '@career-workspace/db';
import { extractCvText, CvTextError } from '@career-workspace/adapters/cv-text';
import { proposeCvFacts } from '@career-workspace/adapters/ai/cv-extract';
import type { PrivateStorage } from '@career-workspace/adapters/storage';
import { getOwnedUserFile } from './files';
import { getTask, startTask, failTask } from './tasks';
import { recordEvent } from './events';
import { ApiError } from './api';
import { deduplicateCvFacts } from './cv-fact-dedup';

type Generator = typeof proposeCvFacts;
const squash = (value: string) => value.toLowerCase().replace(/\s+/g, ' ');

/** Plain job function; milestone 3 will dispatch it through Vercel Workflow. */
export async function runCvExtraction(
  userId: string,
  taskId: string,
  options: {
    database?: Database;
    generate?: Generator;
    storage?: PrivateStorage;
  } = {},
) {
  const database = options.database ?? getDatabase();
  const task = await getTask(userId, taskId, database);
  if (task.kind !== 'cv_extract')
    throw new ApiError(400, 'INVALID_INPUT', 'This is not a CV task.');
  if (task.status === 'succeeded') return task;
  await startTask(userId, taskId, database);
  const logStatus = (status: string, errorCode: string | null = null) =>
    console.error(
      JSON.stringify({ event: 'cv_extract_status', taskId, status, errorCode }),
    );
  logStatus('running');
  try {
    const fileId =
      typeof task.input.fileId === 'string' ? task.input.fileId : '';
    const file = await getOwnedUserFile(userId, fileId, {
      database,
      storage: options.storage,
    });
    if (!file || file.kind !== 'cv_upload')
      throw new CvTextError('INVALID_CV', 'CV file not found.');
    const text = await extractCvText(file.contents, file.contentType ?? '');
    await database
      .update(tasks)
      // Never keep the CV text itself (it holds phone numbers and addresses);
      // a retry reads the stored file again.
      .set({ output: { textLength: text.length }, updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          eq(tasks.status, 'running'),
        ),
      );
    if (
      !options.generate &&
      (!process.env.OPENROUTER_API_KEY ||
        process.env.OPENROUTER_API_KEY.startsWith('REPLACE_WITH_'))
    ) {
      logStatus('failed', 'AI_NOT_CONFIGURED');
      return failTask(userId, taskId, 'AI_NOT_CONFIGURED', database);
    }
    const result = await (options.generate ?? proposeCvFacts)(text);
    const completed = await database.transaction(async (tx) => {
      // Serialize final deduplication across separate extraction tasks. The
      // model call stays outside this lock so unrelated work is not blocked.
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!owner) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
      const existingFacts = await tx
        .select({
          id: profileFacts.id,
          status: profileFacts.status,
          kind: profileFacts.kind,
          text: profileFacts.text,
          organisation: profileFacts.organisation,
          role: profileFacts.role,
          startDate: profileFacts.startDate,
          endDate: profileFacts.endDate,
        })
        .from(profileFacts)
        .where(eq(profileFacts.userId, userId));
      // Include every status so a rejected fact is never reintroduced.
      const { newFacts, duplicateFactCount, duplicateFactIds } =
        deduplicateCvFacts(
          result.object.facts.map((fact) => ({
            ...fact,
            startDate: fact.start,
            endDate: fact.end,
          })),
          existingFacts,
        );
      const facts = newFacts.length
        ? await tx
            .insert(profileFacts)
            .values(
              newFacts.map((fact) => ({
                kind: fact.kind,
                text: fact.text,
                organisation: fact.organisation || null,
                role: fact.role || null,
                startDate: fact.start || null,
                endDate: fact.end || null,
                // Keep the quote only when it really is in the CV text.
                sourceQuote:
                  fact.source_quote &&
                  squash(text).includes(squash(fact.source_quote))
                    ? fact.source_quote
                    : null,
                userId,
                source: 'cv',
                status: 'proposed',
                sourceFileId: fileId,
              })),
            )
            .returning()
        : [];
      await recordEvent(
        {
          userId,
          type: 'profile.cv_extracted',
          subjectType: 'file',
          subjectId: fileId,
          data: {
            taskId,
            newFactCount: facts.length,
            duplicateFactCount,
            promptVersion: result.promptVersion,
            model: result.model,
          },
        },
        tx,
      );
      const [completed] = await tx
        .update(tasks)
        .set({
          status: 'succeeded',
          output: {
            textLength: text.length,
            factIds: facts.map((fact) => fact.id),
            newFactCount: facts.length,
            duplicateFactCount,
            duplicateFactIds,
            promptVersion: result.promptVersion,
            model: result.model,
          },
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.userId, userId),
            eq(tasks.status, 'running'),
          ),
        )
        .returning();
      if (!completed)
        throw new ApiError(
          409,
          'TASK_NOT_RUNNING',
          'This CV task is no longer running.',
        );
      return completed;
    });
    logStatus('succeeded');
    return completed;
  } catch (error) {
    logStatus(
      'failed',
      error instanceof CvTextError ? error.code : 'CV_EXTRACTION_FAILED',
    );
    return failTask(
      userId,
      taskId,
      error instanceof CvTextError ? error.code : 'CV_EXTRACTION_FAILED',
      database,
    );
  }
}
