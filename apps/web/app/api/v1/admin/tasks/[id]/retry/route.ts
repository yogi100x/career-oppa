import { start } from 'workflow/api';
import { adminTaskRetry } from '@career-workspace/contracts';
import { ApiError } from '@career-workspace/core';
import {
  failAdminTaskDispatch,
  retryFailedAdminTask,
} from '@career-workspace/core/admin-tasks';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../../lib/api-route';
import { processRecordedTask } from '../../../../../../../workflows/task-workflow';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    admin: true,
    schema: adminTaskRetry,
    handler: async ({ user, input }) => {
      const task = await retryFailedAdminTask(user.id, id, input);
      try {
        const run = await start(processRecordedTask, [task.userId, task.id]);
        return { task, workflowRunId: run.runId };
      } catch {
        await failAdminTaskDispatch(user.id, task.id);
        throw new ApiError(
          503,
          'WORKFLOW_START_FAILED',
          'The retry could not start. The task is still marked failed.',
        );
      }
    },
  })(request);
}
