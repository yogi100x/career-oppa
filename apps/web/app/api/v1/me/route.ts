import { clerkClient } from '@clerk/nextjs/server';
import { getDatabase, users } from '@career-workspace/db';
import { eq } from 'drizzle-orm';
import { ApiError } from '@career-workspace/core';
import {
  apiOptions,
  authenticateApi,
  createApiHandler,
  withApiCors,
} from '../../../../lib/api-route';

export const runtime = 'nodejs';
const getMe = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => {
    const [row] = await getDatabase()
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
    const identity = await (await clerkClient()).users.getUser(row.clerkId);
    const email =
      identity.emailAddresses.find(
        (address) => address.id === identity.primaryEmailAddressId,
      )?.emailAddress ?? null;
    return {
      id: row.id,
      role: row.role,
      coachId: row.coachId,
      email,
    };
  },
});
export function OPTIONS(request: Request) {
  return apiOptions(request);
}

export async function GET(request: Request) {
  return withApiCors(await getMe(request), request);
}
