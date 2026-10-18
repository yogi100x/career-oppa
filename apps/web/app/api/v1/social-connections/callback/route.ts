import { guardFeature, readFlags } from '@career-workspace/core';
import { completeSocialConnection } from '@career-workspace/core/social-connections';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'publishing');
  if (disabled) return disabled;
  const query = new URL(request.url).searchParams;
  if (query.has('error'))
    return Response.json(
      {
        error: {
          code: 'SOCIAL_OAUTH_FAILED',
          message: 'Social account authorization was not completed.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  const result = await createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) =>
      completeSocialConnection(user.id, {
        platform: query.get('connected'),
        profileId: query.get('profileId'),
        accountId: query.get('accountId'),
      }),
  })(request);
  if (!result.ok) return result;

  const appUrl = process.env.APP_URL;
  if (!appUrl || appUrl.startsWith('REPLACE_WITH_'))
    return Response.json(
      {
        error: {
          code: 'SOCIAL_CALLBACK_NOT_CONFIGURED',
          message: 'The publishing return page is not configured yet.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  const destination = new URL('/workspace/posts', appUrl);
  destination.searchParams.set('connection', 'connected');
  return Response.redirect(destination, 303);
}
