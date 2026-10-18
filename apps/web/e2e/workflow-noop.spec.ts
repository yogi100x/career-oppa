import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures';
import { eq } from 'drizzle-orm';
import { getPrivateStorage } from '@career-workspace/adapters/storage';
import { files, getDatabase } from '@career-workspace/db';

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
type Task = {
  id: string;
  status: string;
  attempts: number;
  output: Record<string, unknown> | null;
};

test('keeps no-op tasks development-only and runs real CV extraction workflow', async ({
  page,
}) => {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  ) {
    throw new Error('Workflow fixtures require career_workspace_test.');
  }
  process.env.DATABASE_URL = databaseUrl;
  const database = getDatabase();
  const start = await page.request.post('/api/v1/tasks/noop', {
    headers: { 'Idempotency-Key': randomUUID() },
  });
  if (process.env.PLAYWRIGHT_PRODUCTION_SERVER === 'true') {
    expect(start.status()).toBe(404);
    const unavailable = (await start.json()) as Envelope<never>;
    expect(unavailable.error?.code).toBe('NOT_FOUND');
  } else {
    expect(start.status()).toBe(202);
    const started = (await start.json()) as Envelope<{
      task: Task;
      workflowRunId: string | null;
    }>;
    expect(started.data?.workflowRunId).toBeTruthy();
    expect(started.data?.task.status).toMatch(/queued|running|succeeded/);

    const taskId = started.data!.task.id;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/v1/tasks/${taskId}`);
          if (!response.ok()) return 'request-failed';
          const envelope = (await response.json()) as Envelope<Task>;
          return envelope.data?.status ?? 'missing';
        },
        { timeout: 30_000 },
      )
      .toBe('succeeded');

    const finalResponse = await page.request.get(`/api/v1/tasks/${taskId}`);
    const completed = (await finalResponse.json()) as Envelope<Task>;
    expect(completed.data).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      output: { noop: true },
    });
  }

  const cvBytes = await readFile(
    'packages/adapters/src/fixtures/sample-cv.docx',
  );
  const cvResponse = await page.request.post('/api/v1/profile/cv', {
    multipart: {
      file: {
        name: 'workflow-fixture.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: cvBytes,
      },
    },
  });
  expect(cvResponse.status()).toBe(201);
  const cvEnvelope = (await cvResponse.json()) as Envelope<{
    file: { id: string };
    task: Task;
    workflowRunId: string;
  }>;
  expect(cvEnvelope.data?.workflowRunId).toBeTruthy();
  const cvTaskId = cvEnvelope.data!.task.id;
  const fileId = cvEnvelope.data!.file.id;
  try {
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/v1/tasks/${cvTaskId}`);
          if (!response.ok()) return null;
          const envelope = (await response.json()) as Envelope<
            Task & { error: string | null }
          >;
          return envelope.data?.status === 'failed'
            ? envelope.data.error
            : null;
        },
        { timeout: 30_000 },
      )
      .toBe('AI_NOT_CONFIGURED');
    const failedResponse = await page.request.get(`/api/v1/tasks/${cvTaskId}`);
    const failed = (await failedResponse.json()) as Envelope<
      Task & { error: string | null }
    >;
    expect(failed.data).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'AI_NOT_CONFIGURED',
    });
    expect(failed.data?.output?.textLength).toBeTruthy();
  } finally {
    const [file] = await database
      .select({ r2Key: files.r2Key })
      .from(files)
      .where(eq(files.id, fileId));
    if (file) {
      await getPrivateStorage().delete(file.r2Key);
      await database.delete(files).where(eq(files.id, fileId));
    }
  }
});
