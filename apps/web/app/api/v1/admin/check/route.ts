import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export const GET = createApiHandler({
  authenticate: authenticateApi,
  admin: true,
  handler: async () => ({ authorized: true }),
});
