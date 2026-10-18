import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function createDatabase(connectionString: string, config: PoolConfig = {}) {
  const pool = new Pool({ connectionString, ...config });
  attachDatabasePool(pool);
  const database = drizzle(pool, { schema });
  return { database, pool };
}

let defaultDatabase: ReturnType<typeof createDatabase> | undefined;

export function getDatabase(): Database {
  if (!defaultDatabase) {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://localhost:5432/career_workspace";
    defaultDatabase = createDatabase(connectionString);
  }
  return defaultDatabase.database;
}

export async function closeDatabase(): Promise<void> {
  if (defaultDatabase) {
    await defaultDatabase.pool.end();
    defaultDatabase = undefined;
  }
}

export async function withTx<T>(
  fn: (tx: Transaction) => Promise<T>,
  database: Database = getDatabase(),
): Promise<T> {
  return database.transaction(fn);
}

export * from "./schema";
