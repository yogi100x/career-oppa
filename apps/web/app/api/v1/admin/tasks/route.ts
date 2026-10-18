import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';
import { listFailedAdminTasks } from '@career-workspace/core/admin-tasks';

export const runtime = 'nodejs';

export const GET = createApiHandler({
  authenticate: authenticateApi,
  admin: true,
  handler: () => listFailedAdminTasks(),
});
