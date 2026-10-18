import { createAnswer, listAnswers } from '@career-workspace/core/answers';
import { createAnswerSchema } from '@career-workspace/contracts';
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
    handler: ({ user }) => listAnswers(user.id, id),
  })(request);
}
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: createAnswerSchema,
    handler: async ({ user, input }) => {
      const key = request.headers.get('idempotency-key') ?? '';
      if (!key)
        throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
      const limit = await checkRateLimit(user.id, 'answer_draft', {
        limit: 10,
        windowMs: 60_000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before drafting another answer.',
        );
      return createAnswer(user.id, id, input.question, key);
    },
  })(request);
}
