import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, users } from "@career-workspace/db";
import { eq } from "drizzle-orm";
import { ensureUserForClerkId } from "./user-record";

const { getClerkUser } = vi.hoisted(() => ({ getClerkUser: vi.fn() }));
vi.mock('server-only', () => ({}));
// Recorded identity replies are confined to this database integration test.
// Browser checks use real Clerk sessions and the actual backend API.
vi.mock('@clerk/nextjs/server', () => ({ clerkClient: async () => ({ users: { getUser: getClerkUser } }) }));

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration("Clerk user record sync", () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkId = randomUUID();

  afterAll(async () => {
    await database.delete(users).where(eq(users.clerkId, clerkId));
    await pool.end();
  });

  it("returns the same local row when one Clerk identity is synced twice", async () => {
    getClerkUser.mockResolvedValue({ id: clerkId });
    const first = await ensureUserForClerkId(clerkId, database);
    const second = await ensureUserForClerkId(clerkId, database);

    expect(second.id).toBe(first.id);
    expect(second.clerkId).toBe(clerkId);

    const matchingUsers = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, clerkId));
    expect(matchingUsers).toHaveLength(1);
    expect(getClerkUser).toHaveBeenCalledTimes(1);
  });

  it('does not recreate a local row from a deleted Clerk identity', async () => {
    await database.delete(users).where(eq(users.clerkId, clerkId));
    getClerkUser.mockRejectedValueOnce({ status: 404 });
    await expect(ensureUserForClerkId(clerkId, database)).rejects.toThrow('This sign-in account has been deleted.');
    expect(await database.select().from(users).where(eq(users.clerkId, clerkId))).toHaveLength(0);
  });
});
