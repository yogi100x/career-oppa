import { answerApplicationHandoffSchema } from '@career-workspace/contracts';
import { answerApplicationHandoff } from '@career-workspace/core/application-handoff';
import { authenticateApi, createApiHandler } from '../../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: answerApplicationHandoffSchema,
    handler: ({ user, input }) => answerApplicationHandoff(user.id, id, input),
  })(request);
}
