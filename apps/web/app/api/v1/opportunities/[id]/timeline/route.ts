import { getOpportunityTimeline } from '@career-workspace/core/opportunity-status';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => ({
      timeline: await getOpportunityTimeline(user.id, id),
    }),
  })(request);
}
