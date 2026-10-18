import { listPendingReminders } from '@career-workspace/core/reminders';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';

export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => ({
    reminders: await listPendingReminders(user.id),
  }),
});
