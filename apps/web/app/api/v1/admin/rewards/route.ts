import { listRewardQueue } from '@career-workspace/core/rewards';
import { authenticateApi, createApiHandler, withApiCors } from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export const GET = async (request: Request) => withApiCors(await createApiHandler({
  authenticate: authenticateApi,
  admin: true,
  handler: () => listRewardQueue(),
})(request), request);
