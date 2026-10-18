import { createPostSchema } from '@career-workspace/contracts';
import {
  ApiError,
  checkRateLimit,
  guardFeature,
  readFlags,
} from '@career-workspace/core';
import { createPost, listPosts } from '@career-workspace/core/publishing';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'publishing');
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => listPosts(user.id),
  })(request);
}
export async function POST(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'publishing');
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: createPostSchema,
    handler: async ({ user, input }) => {
      const limit = await checkRateLimit(user.id, 'post_draft', {
        limit: 5,
        windowMs: 60000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before drafting another post.',
        );
      return createPost(
        user.id,
        input.projectId,
        request.headers.get('idempotency-key') ?? '',
      );
    },
  })(request);
}
