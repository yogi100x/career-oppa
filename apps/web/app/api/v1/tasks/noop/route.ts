import { start } from 'workflow/api';
import { createTask, ApiError } from '@career-workspace/core';
import { processRecordedTask } from '../../../../../workflows/task-workflow';
import { authenticateApi } from '../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV !== 'development') {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Route not found.' } },
      { status: 404 },
    );
  }
  try {
    const user = await authenticateApi(request);
    if (!user)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const requestKey = request.headers.get('idempotency-key')?.trim() ?? '';
    if (!requestKey || requestKey.length > 200)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Provide a valid idempotency key.',
      );
    const task = await createTask(user.id, 'noop', requestKey);
    if (task.status === 'succeeded')
      return Response.json(
        { data: { task, workflowRunId: null } },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (task.status === 'running')
      return Response.json(
        { data: { task, workflowRunId: null } },
        { status: 202, headers: { 'Cache-Control': 'no-store' } },
      );
    const workflow = await start(processRecordedTask, [user.id, task.id]);
    return Response.json(
      { data: { task, workflowRunId: workflow.runId } },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const safe =
      error instanceof ApiError
        ? error
        : new ApiError(
            500,
            'WORKFLOW_START_FAILED',
            'The task could not be started.',
          );
    return Response.json(
      { error: { code: safe.code, message: safe.message } },
      { status: safe.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
