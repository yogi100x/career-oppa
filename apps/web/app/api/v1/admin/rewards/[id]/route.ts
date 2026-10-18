import { reviewReward } from '@career-workspace/core/rewards';
import { reviewRewardSchema } from '@career-workspace/contracts';
import { authenticateApi, createApiHandler, withApiCors } from '../../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiCors(await createApiHandler({
    authenticate: authenticateApi,
    admin: true,
    schema: reviewRewardSchema,
    handler: ({ user, input }) => reviewReward(user.id, id, input),
  })(request), request);
}
