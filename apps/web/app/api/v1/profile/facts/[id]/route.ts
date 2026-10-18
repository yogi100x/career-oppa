import { updateProfileFact } from '@career-workspace/core';
import { patchProfileFact } from '@career-workspace/contracts';
import { authenticateApi, createApiHandler } from '../../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: patchProfileFact,
    handler: ({ user, input }) => updateProfileFact(user.id, id, input),
  })(request);
}
