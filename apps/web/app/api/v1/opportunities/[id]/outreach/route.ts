import { createOutreachSchema } from '@career-workspace/contracts';
import { ApiError, checkRateLimit } from '@career-workspace/core';
import { createOutreach, listOutreach } from '@career-workspace/core/outreach';
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
    handler: ({ user }) => listOutreach(user.id, id),
  })(request);
}
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: createOutreachSchema,
    handler: async ({ user, input }) => {
      const limit = await checkRateLimit(user.id, 'outreach_draft', {
        limit: 10,
        windowMs: 60_000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before drafting another email.',
        );
      return createOutreach(
        user.id,
        id,
        input,
        request.headers.get('idempotency-key') ?? '',
      );
    },
  })(request);
}
