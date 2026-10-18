import { sql } from "drizzle-orm";
import {
  getDatabase,
  rateLimits,
  type Database,
} from "@career-workspace/db";

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
};

export async function checkRateLimit(
  userId: string,
  actionKey: string,
  options: RateLimitOptions,
  database: Database = getDatabase(),
): Promise<RateLimitResult> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new RangeError("Rate limit must be a positive whole number.");
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new RangeError("Rate-limit window must be a positive whole number of milliseconds.");
  }
  if (!actionKey.trim()) {
    throw new Error("Rate-limit action key cannot be empty.");
  }

  const windowExpired = sql`
    ${rateLimits.windowStart} + (${options.windowMs} * interval '1 millisecond')
      <= statement_timestamp()
  `;

  const statement = database
    .insert(rateLimits)
    .values({ userId, actionKey })
    .onConflictDoUpdate({
      target: [rateLimits.userId, rateLimits.actionKey],
      set: {
        windowStart: sql`CASE WHEN ${windowExpired}
          THEN statement_timestamp()
          ELSE ${rateLimits.windowStart} END`,
        count: sql`CASE WHEN ${windowExpired}
          THEN 1
          ELSE LEAST(${rateLimits.count} + 1, ${options.limit + 1}) END`,
      },
    })
    .returning({ windowStart: rateLimits.windowStart, count: rateLimits.count });
  const [row] = await statement;

  const resetAt = new Date(row.windowStart.getTime() + options.windowMs);
  return {
    allowed: row.count <= options.limit,
    remaining: Math.max(0, options.limit - row.count),
    resetAt,
  };
}
