import { guardFeature, readFlags } from '@career-workspace/core';
import { getDiscoveryFeed } from '@career-workspace/core/discovery';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'discovery');
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => getDiscoveryFeed(user.id),
  })(request);
}
