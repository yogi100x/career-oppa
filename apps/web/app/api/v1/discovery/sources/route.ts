import { ApiError, guardFeature, readFlags } from '@career-workspace/core';
import { getDiscoveryHealth } from '@career-workspace/core/discovery';
import { authenticateApi, createApiHandler } from '../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'discovery');
  if (disabled) return disabled;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user, request: currentRequest }) => {
      const rawOffset = new URL(currentRequest.url).searchParams.get('offset') ?? '0';
      if (!/^(0|[1-9]\d*)$/.test(rawOffset))
        throw new ApiError(400, 'INVALID_INPUT', 'Offset must be a non-negative whole number.');
      const offset = Number(rawOffset);
      if (!Number.isSafeInteger(offset) || offset > 100_000)
        throw new ApiError(400, 'INVALID_INPUT', 'Offset must be between 0 and 100000.');
      return getDiscoveryHealth(user.id, offset);
    },
  })(request);
}
