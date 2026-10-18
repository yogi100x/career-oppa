import { start } from 'workflow/api';
import {
  ApiError,
  createAccountDeletionTask,
  getAccountDeletionStatus,
  markAccountDeletionDispatchFailed,
} from '@career-workspace/core';
import { accountDeletionRequest } from '@career-workspace/contracts';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';
import { processRecordedTask } from '../../../../../workflows/task-workflow';

export const runtime = 'nodejs';

const getStatus = createApiHandler({
  authenticate: authenticateApi,
  allowDeletionPending: true,
  handler: ({ user }) => getAccountDeletionStatus(user.id),
});

const requestDeletion = createApiHandler({
  authenticate: authenticateApi,
  schema: accountDeletionRequest,
  allowDeletionPending: true,
  handler: async ({ user, request }) => {
    const requestKey = request.headers.get('idempotency-key');
    if (!requestKey)
      throw new ApiError(400, 'INVALID_INPUT', 'A request key is required.');
    const task = await createAccountDeletionTask(user.id, requestKey);
    let workflowRunId: string | null = null;
    if (task.status === 'queued' || task.status === 'failed') {
      try {
        const workflow = await start(processRecordedTask, [user.id, task.id]);
        workflowRunId = workflow.runId;
      } catch {
        await markAccountDeletionDispatchFailed(user.id, task.id);
        throw new ApiError(
          503,
          'WORKFLOW_UNAVAILABLE',
          'Account cleanup could not start. Retry from this page.',
        );
      }
    }
    return {
      task: { id: task.id, status: task.status, error: task.error },
      workflowRunId,
    };
  },
});

export async function GET(request: Request) {
  return getStatus(request);
}

export async function POST(request: Request) {
  return requestDeletion(request);
}
