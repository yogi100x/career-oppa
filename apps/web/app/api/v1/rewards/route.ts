import { listRewardSubmissions, submitReward } from '@career-workspace/core/rewards';
import { submitRewardSchema } from '@career-workspace/contracts';
import { authenticateApi, createApiHandler, withApiCors } from '../../../../lib/api-route';

export const runtime = 'nodejs';
export const GET = async (request: Request) => withApiCors(await createApiHandler({
  authenticate: authenticateApi,
  handler: ({ user }) => listRewardSubmissions(user.id),
})(request), request);
export const POST = async (request: Request) => withApiCors(await createApiHandler({
  authenticate: authenticateApi,
  schema: submitRewardSchema,
  handler: ({ user, input }) => submitReward(user.id, input),
})(request), request);
