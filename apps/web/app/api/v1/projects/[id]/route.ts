import { deleteProject, updateProject } from '@career-workspace/core';
import { patchProject as patchProjectInput } from '@career-workspace/contracts';
import { authenticateApi, createApiHandler } from '../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: patchProjectInput,
    handler: ({ user, input }) => updateProject(user.id, id, input),
  })(request);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => deleteProject(user.id, id),
  })(request);
}
