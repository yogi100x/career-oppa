import { start } from 'workflow/api';
import { and, eq } from 'drizzle-orm';
import { getDatabase, tasks } from '@career-workspace/db';
import { processRecordedTask } from '../workflows/task-workflow';

export async function dispatchCvRead(
  userId: string,
  task: { id: string },
  shouldStart: boolean,
) {
  if (!shouldStart) return null;
  console.info(
    JSON.stringify({
      event: 'cv_extract_status',
      taskId: task.id,
      status: 'queued',
      errorCode: null,
    }),
  );
  try {
    const workflow = await start(processRecordedTask, [userId, task.id]);
    return workflow.runId;
  } catch {
    // The file is already saved. Keep that successful upload visible and make
    // its failed dispatch retryable without sending the file again.
    await getDatabase()
      .update(tasks)
      .set({
        status: 'failed',
        error: 'WORKFLOW_START_FAILED',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.userId, userId),
          eq(tasks.status, 'queued'),
        ),
      );
    console.info(
      JSON.stringify({
        event: 'cv_extract_status',
        taskId: task.id,
        status: 'failed',
        errorCode: 'WORKFLOW_START_FAILED',
      }),
    );
    return null;
  }
}
