import {
  addSuppression,
  listSuppressions,
} from '@career-workspace/core/suppressions';
import { createSuppression } from '@career-workspace/contracts';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';

export const GET = createApiHandler({
  authenticate: authenticateApi,
  admin: true,
  handler: () => listSuppressions(),
});

export const POST = createApiHandler({
  authenticate: authenticateApi,
  admin: true,
  schema: createSuppression,
  handler: ({ user, input }) => addSuppression(user.id, input),
});
