import { captureJobSchema } from '@career-workspace/contracts';
import { createJob } from '@career-workspace/core/roles';
import { ApiError, checkRateLimit } from '@career-workspace/core';
import {
  apiOptions,
  authenticateApi,
  createApiHandler,
  withApiCors,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export const OPTIONS = apiOptions;
const capture = createApiHandler({
  authenticate: authenticateApi,
  schema: captureJobSchema,
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
    return createJob(user.id, input, { source: 'extension' });
  },
});
export async function POST(request: Request) {
  return withApiCors(await capture(request), request);
}
