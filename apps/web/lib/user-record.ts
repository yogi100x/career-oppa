import 'server-only';
import {
  getDatabase,
  users,
  type Database,
  type User,
} from '@career-workspace/db';
import { eq, sql } from 'drizzle-orm';
import { clerkClient } from '@clerk/nextjs/server';

export class ClerkIdentityMissingError extends Error {
  constructor() {
    super('This sign-in account has been deleted.');
  }
}

/** Creates the local user row once for each Clerk identity. */
export async function ensureUserForClerkId(
  clerkId: string,
  database: Database = getDatabase(),
): Promise<User> {
  if (!clerkId.trim()) {
    throw new Error('A Clerk user ID is required.');
  }

  return database.transaction(async (tx) => {
    // This lock is also held through final identity deletion, so a stale Clerk
    // session cannot recreate the local row after deletion commits.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${clerkId}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);
    if (existing) return existing;

    try {
      await (await clerkClient()).users.getUser(clerkId);
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'status' in error
          ? error.status
          : undefined;
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? error.statusCode
          : undefined;
      if (status === 404 || statusCode === 404)
        throw new ClerkIdentityMissingError();
      throw error;
    }

    const [created] = await tx
      .insert(users)
      .values({ clerkId })
      .onConflictDoNothing({ target: users.clerkId })
      .returning();
    if (created) return created;
    const [raced] = await tx
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);
    if (!raced)
      throw new Error('Could not find the local user for this Clerk account.');
    return raced;
  });
}
