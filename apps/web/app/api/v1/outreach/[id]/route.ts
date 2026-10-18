import { outreachContentSchema } from '@career-workspace/contracts';
import { editOutreach, getOutreach } from '@career-workspace/core/outreach';
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
    handler: ({ user }) => getOutreach(user.id, id),
  })(request);
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: outreachContentSchema,
    handler: ({ user, input }) => editOutreach(user.id, id, input),
  })(request);
}
