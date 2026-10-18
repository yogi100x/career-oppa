import { editPostSchema } from '@career-workspace/contracts';
import { guardFeature, readFlags } from '@career-workspace/core';
import { getPost, editPost } from '@career-workspace/core/publishing';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const disabled = guardFeature(readFlags(process.env), 'publishing');
  if (disabled) return disabled;
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => getPost(user.id, id),
  })(request);
}
export async function PATCH(request: Request, context: Context) {
  const disabled = guardFeature(readFlags(process.env), 'publishing');
  if (disabled) return disabled;
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: editPostSchema,
    handler: ({ user, input }) => editPost(user.id, id, input),
  })(request);
}
