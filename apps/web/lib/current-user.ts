import 'server-only';

import { auth } from '@clerk/nextjs/server';
import { ClerkIdentityMissingError, ensureUserForClerkId } from './user-record';

/** Returns the signed-in user's local row, creating it on first access. */
export async function getCurrentUser() {
  const { userId } = await auth();
  if (!userId) return null;
  try {
    return await ensureUserForClerkId(userId);
  } catch (error) {
    if (error instanceof ClerkIdentityMissingError) return null;
    throw error;
  }
}
