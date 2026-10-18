import { getCoachAllowance } from '@career-workspace/core/coach';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: ({ user }) => getCoachAllowance(user.id),
});
