import { listCoachToolProposals } from '@career-workspace/core/coach-toolset';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: ({ user }) => listCoachToolProposals(user.id),
});
