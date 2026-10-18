import {
  createFitReview,
  getFitReviews,
} from '@career-workspace/core/fit-review';
import { ApiError, checkRateLimit } from '@career-workspace/core';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => getFitReviews(user.id, id),
  })(request);
}
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => {
      const key = request.headers.get('idempotency-key') ?? '';
      if (!key)
        throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
      const limit = await checkRateLimit(user.id, 'fit_review', {
        limit: 10,
        windowMs: 60_000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before another fit review.',
        );
      return createFitReview(user.id, id, key, {
        requireFree: request.headers.get('x-review-price') === 'free',
      });
    },
  })(request);
}
