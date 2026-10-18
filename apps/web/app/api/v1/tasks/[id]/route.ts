import { ApiError, getTask } from '@career-workspace/core';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        throw new ApiError(404, 'NOT_FOUND', 'Task not found.');
      return getTask(user.id, id);
    },
  })(request);
}
