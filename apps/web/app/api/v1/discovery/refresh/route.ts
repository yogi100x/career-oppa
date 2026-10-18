import { and, eq } from 'drizzle-orm';
import { start } from 'workflow/api';
import { ApiError, checkRateLimit, guardFeature, readFlags } from '@career-workspace/core';
import { getDatabase, tasks } from '@career-workspace/db';
import { createTask } from '@career-workspace/core/tasks';
import { authenticateApi, createApiHandler } from '../../../../../lib/api-route';
import { processRecordedTask } from '../../../../../workflows/task-workflow';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'discovery');
  if (disabled) return disabled;
  const response = await createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => {
      const requestKey = request.headers.get('idempotency-key')?.trim() ?? '';
      if (!requestKey || requestKey.length > 200)
        throw new ApiError(400, 'INVALID_INPUT', 'Provide a valid idempotency key.');
      const key = `discovery:${requestKey}`;
      const idempotencyKey = `task:${user.id}:${key}`;
      const [existing] = await getDatabase().select().from(tasks).where(and(
        eq(tasks.userId, user.id), eq(tasks.idempotencyKey, idempotencyKey),
      ));
      if (existing?.status === 'running' || existing?.status === 'succeeded')
        return { started: false, task: existing, workflowRunId: null };
      if (!existing) {
        const limit = await checkRateLimit(user.id, 'discovery_refresh', {
          limit: 1,
          windowMs: 15 * 60_000,
        });
        if (!limit.allowed)
          throw new ApiError(429, 'RATE_LIMITED', 'Wait 15 minutes before requesting another refresh.');
      }
      const task = await createTask(user.id, 'job_discovery', key);
      const workflow = await start(processRecordedTask, [user.id, task.id]);
      return { started: true, task, workflowRunId: workflow.runId };
    },
  })(request);
  if (response.status !== 200) return response;
  const body = await response.json() as { data?: { started?: boolean } };
  return body.data?.started
    ? Response.json(body, { status: 202, headers: response.headers })
    : Response.json(body, { headers: response.headers });
}
