import { sql } from "drizzle-orm";
import { createDatabase } from "./client";

const allowedDatabaseName = "career_workspace_test";

function assertTestDatabase(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (databaseName !== allowedDatabaseName) {
    throw new Error(
      `Reset helper is restricted to the ${allowedDatabaseName} database.`,
    );
  }
}

export async function resetTestDatabase(
  connectionString = process.env.DATABASE_TEST_URL,
): Promise<void> {
  if (!connectionString) {
    throw new Error("DATABASE_TEST_URL must point to career_workspace_test.");
  }
  assertTestDatabase(connectionString);

  const { database, pool } = createDatabase(connectionString);
  try {
    await database.execute(sql`
      TRUNCATE TABLE events, users RESTART IDENTITY CASCADE
    `);
  } finally {
    await pool.end();
  }
}
