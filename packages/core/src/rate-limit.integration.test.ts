import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, users } from "@career-workspace/db";
import { checkRateLimit } from "./rate-limit";

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
if (
  testDatabaseUrl &&
  new URL(testDatabaseUrl).pathname.slice(1) !== "career_workspace_test"
) {
  throw new Error("DATABASE_TEST_URL must target career_workspace_test.");
}
const integration = testDatabaseUrl ? describe : describe.skip;

integration("Postgres rate limiter", () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const runToken = randomUUID();
  let firstUserId: string;
  let secondUserId: string;

  beforeAll(async () => {
    const createdUsers = await database
      .insert(users)
      .values([
        { clerkId: `rate-limit-test-a-${runToken}` },
        { clerkId: `rate-limit-test-b-${runToken}` },
      ])
      .returning({ id: users.id });
    [firstUserId, secondUserId] = createdUsers.map(({ id }) => id);
  });

  afterAll(async () => {
    if (firstUserId && secondUserId) {
      await database
        .delete(users)
        .where(inArray(users.id, [firstUserId, secondUserId]));
    }
    await pool.end();
  });

  it("denies requests after the configured per-user limit", async () => {
    const action = `sequential-${runToken}`;
    const options = { limit: 2, windowMs: 60_000 };
    const results = await Promise.all([
      checkRateLimit(firstUserId, action, options, database),
      checkRateLimit(firstUserId, action, options, database),
      checkRateLimit(firstUserId, action, options, database),
    ]);

    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    expect(results.find((result) => !result.allowed)?.remaining).toBe(0);

    const otherUser = await checkRateLimit(
      secondUserId,
      action,
      options,
      database,
    );
    expect(otherUser.allowed).toBe(true);
    expect(otherUser.remaining).toBe(1);
  });

  it("caps parallel requests atomically", async () => {
    const action = `parallel-${runToken}`;
    const options = { limit: 7, windowMs: 60_000 };
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        checkRateLimit(firstUserId, action, options, database),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(7);
    expect(results.filter((result) => !result.allowed)).toHaveLength(17);
    expect(results.every((result) => result.remaining >= 0)).toBe(true);
    expect(results.every((result) => result.resetAt.getTime() === results[0].resetAt.getTime())).toBe(true);
  });
});
