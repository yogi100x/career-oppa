import { approvePostSchema } from '@career-workspace/contracts';
import { guardFeature, readFlags } from '@career-workspace/core';
import { approvePost } from '@career-workspace/core/publishing';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const disabled = guardFeature(readFlags(process.env), 'publishing');
  if (disabled) return disabled;
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: approvePostSchema,
    handler: ({ user, input }) => approvePost(user.id, id, input),
  })(request);
}
