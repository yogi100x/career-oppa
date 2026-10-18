import { start } from 'workflow/api';
import {
  ApiError,
  checkRateLimit,
  guardFeature,
  readFlags,
} from '@career-workspace/core';
import { createPublishTask } from '@career-workspace/core/publishing';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';
import { processRecordedTask } from '../../../../../../workflows/task-workflow';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const disabled = guardFeature(readFlags(process.env), 'publishing');
  if (disabled) return disabled;
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => {
      const limit = await checkRateLimit(user.id, 'publish_post', {
        limit: 5,
        windowMs: 60000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before checking publishing again.',
        );
      const task = await createPublishTask(user.id, id);
      if (task.status === 'succeeded') return { task, workflowRunId: null };
      const workflow = await start(processRecordedTask, [user.id, task.id]);
      return { task, workflowRunId: workflow.runId };
    },
  })(request);
}
