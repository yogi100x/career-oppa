import { revealContactEmail } from '@career-workspace/core/contacts';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => revealContactEmail(user.id, id),
  })(request);
}
