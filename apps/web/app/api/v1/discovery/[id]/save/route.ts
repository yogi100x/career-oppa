import { guardFeature, readFlags } from '@career-workspace/core';
import { saveDiscoveredJob } from '@career-workspace/core/discovery';
import { authenticateApi, createApiHandler } from '../../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const disabled = guardFeature(readFlags(process.env), 'discovery');
  if (disabled) return disabled;
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => saveDiscoveredJob(user.id, id),
  })(request);
}
