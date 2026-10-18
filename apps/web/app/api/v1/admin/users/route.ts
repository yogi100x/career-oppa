import { lookupUsers } from '@career-workspace/core/rewards';
import { authenticateApi, createApiHandler, withApiCors } from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return withApiCors(await createApiHandler({
    authenticate: authenticateApi,
    admin: true,
    handler: ({ request: incoming }) => lookupUsers(new URL(incoming.url).searchParams.get('q') ?? ''),
  })(request), request);
}
