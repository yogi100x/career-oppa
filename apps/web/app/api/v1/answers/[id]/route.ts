import { getAnswer, editAnswer } from '@career-workspace/core/answers';
import { editAnswerSchema } from '@career-workspace/contracts';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => getAnswer(user.id, id),
  })(request);
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: editAnswerSchema,
    handler: ({ user, input }) => editAnswer(user.id, id, input),
  })(request);
}
