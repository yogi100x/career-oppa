import { getAnswerGrounding } from '@career-workspace/core/answers';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => getAnswerGrounding(user.id, id),
  })(request);
}
