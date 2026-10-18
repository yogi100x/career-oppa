import { getResume, editResume } from '@career-workspace/core/resumes';
import { editResumeSchema } from '@career-workspace/contracts';
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
    handler: ({ user }) => getResume(user.id, id),
  })(request);
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: editResumeSchema,
    handler: ({ user, input }) => editResume(user.id, id, input.content),
  })(request);
}
