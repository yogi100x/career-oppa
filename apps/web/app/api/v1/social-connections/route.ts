import { guardFeature, readFlags } from '@career-workspace/core';
import {
  disconnectSocialConnection,
  getSocialConnection,
  startSocialConnection,
} from '@career-workspace/core/social-connections';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';

function featureDisabled() {
  return guardFeature(readFlags(process.env), 'publishing');
}

export async function GET(request: Request) {
  const disabled = featureDisabled();
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => getSocialConnection(user.id),
  })(request);
}

export async function POST(request: Request) {
  const disabled = featureDisabled();
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => startSocialConnection(user.id),
  })(request);
}

export async function DELETE(request: Request) {
  const disabled = featureDisabled();
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => disconnectSocialConnection(user.id),
  })(request);
}
