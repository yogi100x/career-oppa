import { approveAnswer } from '@career-workspace/core/answers';
import { approveAnswerSchema } from '@career-workspace/contracts';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: approveAnswerSchema,
    handler: ({ user, input }) =>
      approveAnswer(user.id, id, input.confirmedFactPairs),
  })(request);
}
