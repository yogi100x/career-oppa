import { createPracticeSchema } from '@career-workspace/contracts';
import {
  ApiError,
  checkRateLimit,
  guardFeature,
  readFlags,
} from '@career-workspace/core';
import { createPractice, listPractice } from '@career-workspace/core/practice';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'practice');
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: createPracticeSchema,
    handler: async ({ user, input }) => {
      const limit = await checkRateLimit(user.id, 'practice_start', {
        limit: 5,
        windowMs: 60_000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before starting another session.',
        );
      return createPractice(
        user.id,
        input.opportunityId,
        request.headers.get('idempotency-key') ?? '',
      );
    },
  })(request);
}
export async function GET(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'practice');
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => {
      const id = new URL(request.url).searchParams.get('opportunityId');
      if (!id)
        throw new ApiError(400, 'INVALID_INPUT', 'Choose a role for practice.');
      return listPractice(user.id, id);
    },
  })(request);
}
