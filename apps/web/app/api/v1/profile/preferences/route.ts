import { profilePreferences } from '@career-workspace/contracts';
import {
  getProfilePreferences,
  saveProfilePreferences,
} from '@career-workspace/core';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';
export const runtime = 'nodejs';
export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => getProfilePreferences(user.id),
});
export const PATCH = createApiHandler({
  authenticate: authenticateApi,
  schema: profilePreferences,
  handler: async ({ user, input }) => saveProfilePreferences(user.id, input),
});
