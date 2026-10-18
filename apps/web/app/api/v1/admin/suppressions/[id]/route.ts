import { removeSuppression } from '@career-workspace/core/suppressions';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    admin: true,
    handler: ({ user }) => removeSuppression(user.id, id),
  })(request);
}
