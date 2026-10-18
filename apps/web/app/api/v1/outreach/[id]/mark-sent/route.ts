import { outreachSentSchema } from '@career-workspace/contracts';
import { markOutreachSent } from '@career-workspace/core/outreach';
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
    schema: outreachSentSchema,
    handler: ({ user }) => markOutreachSent(user.id, id),
  })(request);
}
