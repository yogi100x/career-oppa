import { getOpportunity } from '@career-workspace/core/roles';
import { updateOpportunitySchema } from '@career-workspace/contracts';
import { updateOpportunityStatus } from '@career-workspace/core/opportunity-status';
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
    handler: ({ user }) => getOpportunity(user.id, id),
  })(request);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: updateOpportunitySchema,
    handler: ({ user, input }) =>
      updateOpportunityStatus(user.id, id, input.status),
  })(request);
}
