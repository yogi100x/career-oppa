import { listProfileFacts, createProfileFact } from '@career-workspace/core';
import { createProfileFact as createProfileFactSchema } from '@career-workspace/contracts';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';

const getFacts = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => ({ facts: await listProfileFacts(user.id) }),
});

export function GET(request: Request) {
  return getFacts(request);
}
export const POST = createApiHandler({
  authenticate: authenticateApi,
  schema: createProfileFactSchema,
  handler: ({ user, input }) => createProfileFact(user.id, input),
});
