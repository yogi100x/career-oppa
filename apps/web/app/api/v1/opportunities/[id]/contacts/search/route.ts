import { start } from 'workflow/api';
import { ApiError } from '@career-workspace/core';
import { createContactsSearchTask } from '@career-workspace/core/contacts';
import { processRecordedTask } from '../../../../../../../workflows/task-workflow';
import {
  authenticateApi,
  logApiFailure,
  manualRouteAccessError,
  withRequestId,
} from '../../../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    const user = await authenticateApi(request);
    const accessError = manualRouteAccessError(user);
    if (!user) return accessError!;
    if (accessError) return accessError;
    const requestKey = request.headers.get('idempotency-key')?.trim() ?? '';
    if (!requestKey || requestKey.length > 200)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Provide a valid idempotency key.',
      );

    const task = await createContactsSearchTask(user.id, id, requestKey);
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
            'The search could not be started.',
          );
    const response = Response.json(
      { error: { code: safe.code, message: safe.message } },
      { status: safe.status, headers: { 'Cache-Control': 'no-store' } },
    );
    return error instanceof ApiError
      ? response
      : withRequestId(
          response,
          logApiFailure(request, 'WORKFLOW_START_FAILED'),
        );
  }
}
