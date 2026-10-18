import { createApplicationHandoffSchema } from '@career-workspace/contracts';
import {
  createApplicationHandoff,
  listPendingApplicationHandoffs,
} from '@career-workspace/core/application-handoff';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';

export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: ({ user }) => listPendingApplicationHandoffs(user.id),
});

export const POST = createApiHandler({
  authenticate: authenticateApi,
  schema: createApplicationHandoffSchema,
  handler: ({ user, input }) => createApplicationHandoff(user.id, input),
});
