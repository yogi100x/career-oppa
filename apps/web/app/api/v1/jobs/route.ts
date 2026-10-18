import { createJobSchema } from '@career-workspace/contracts';
import { createJob } from '@career-workspace/core/roles';
import { ApiError, checkRateLimit } from '@career-workspace/core';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';
export const POST = createApiHandler({
  authenticate: authenticateApi,
  schema: createJobSchema,
  handler: async ({ user, input }) => {
    const limit = await checkRateLimit(user.id, 'save_role', {
      limit: 20,
      windowMs: 60_000,
    });
    if (!limit.allowed)
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Wait a minute before saving another role.',
      );
    return createJob(user.id, input);
  },
});
