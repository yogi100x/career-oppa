import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from 'drizzle-orm';
import { createDatabase, users } from "@career-workspace/db";
import { queryEventsBySubject, recordEvent } from "./index";

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
if (
  testDatabaseUrl &&
  new URL(testDatabaseUrl).pathname.slice(1) !== "career_workspace_test"
) {
  throw new Error("DATABASE_TEST_URL must target career_workspace_test.");
}
const integration = testDatabaseUrl ? describe : describe.skip;

integration("events database integration", () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  let firstUserId: string;
  let secondUserId: string;
  const runToken = randomUUID();

  beforeAll(async () => {
    const createdUsers = await database
      .insert(users)
      .values([
        { clerkId: `events-test-user-a-${runToken}` },
        { clerkId: `events-test-user-b-${runToken}` },
      ])
      .returning({ id: users.id });
    [firstUserId, secondUserId] = createdUsers.map(({ id }) => id);
  });

  afterAll(async () => {
    if (firstUserId && secondUserId) await database.delete(users).where(inArray(users.id, [firstUserId, secondUserId]));
    await pool.end();
  });

  it("writes and reads events only for the requested user's subject", async () => {
    const subject = {
      subjectType: "opportunity",
      subjectId: `same-subject-${runToken}`,
    };
    await recordEvent(
      { ...subject, userId: firstUserId, type: "status_changed" },
      database,
    );
    await recordEvent(
      { ...subject, userId: secondUserId, type: "status_changed" },
      database,
    );
    await recordEvent(
      {
        ...subject,
        userId: firstUserId,
        type: "internal_audit",
        visibility: "internal",
      },
      database,
    );

    const firstUserEvents = await queryEventsBySubject(
      { ...subject, userId: firstUserId },
      database,
    );
    const secondUserEvents = await queryEventsBySubject(
      { ...subject, userId: secondUserId },
      database,
    );

    expect(firstUserEvents).toHaveLength(1);
    expect(secondUserEvents).toHaveLength(1);
    expect(firstUserEvents[0].userId).toBe(firstUserId);
    expect(secondUserEvents[0].userId).toBe(secondUserId);
  });
});
