import { outreachReplySchema } from '@career-workspace/contracts';
import { markContactOutcome } from '@career-workspace/core/outreach';
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
    schema: outreachReplySchema,
    handler: ({ user, input }) =>
      markContactOutcome(user.id, id, input.outcome),
  })(request);
}
