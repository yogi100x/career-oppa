import { guardFeature, readFlags } from '@career-workspace/core';
import { getPractice } from '@career-workspace/core/practice';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const disabled = guardFeature(readFlags(process.env), 'practice');
  if (disabled) return disabled;
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => getPractice(user.id, id),
  })(request);
}
