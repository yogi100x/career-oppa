import { listOpportunities } from '@career-workspace/core/roles';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';
export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: ({ user }) => listOpportunities(user.id),
});
