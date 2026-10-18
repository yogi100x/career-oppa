import { practiceAnswersSchema } from '@career-workspace/contracts';
import {
  ApiError,
  checkRateLimit,
  guardFeature,
  readFlags,
} from '@career-workspace/core';
import { submitPracticeAnswers } from '@career-workspace/core/practice';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const disabled = guardFeature(readFlags(process.env), 'practice');
  if (disabled) return disabled;
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: practiceAnswersSchema,
    handler: async ({ user, input }) => {
      const limit = await checkRateLimit(user.id, 'practice_feedback', {
        limit: 5,
        windowMs: 60_000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before requesting feedback again.',
        );
      return submitPracticeAnswers(user.id, id, input);
    },
  })(request);
}
