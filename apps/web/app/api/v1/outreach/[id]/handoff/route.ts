import { outreachHandoffSchema } from '@career-workspace/contracts';
import { handoffOutreach } from '@career-workspace/core/outreach';
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
    schema: outreachHandoffSchema,
    handler: ({ user, input }) => handoffOutreach(user.id, id, input),
  })(request);
}
