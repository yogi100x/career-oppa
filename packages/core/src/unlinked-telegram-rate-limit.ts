import { sql } from 'drizzle-orm';
import { getDatabase, rateLimits, type Database } from '@career-workspace/db';

/** Allow five replies per Telegram account per rolling hour, then stay quiet. */
export async function allowUnlinkedTelegramReply(
  telegramUserId: string,
  database: Database = getDatabase(),
): Promise<boolean> {
  const windowMs = 60 * 60_000;
  const expired = sql`
    ${rateLimits.windowStart} + (${windowMs} * interval '1 millisecond')
      <= statement_timestamp()
  `;
  const [row] = await database
    .insert(rateLimits)
    .values({
      externalSubject: `telegram:${telegramUserId}`,
      actionKey: 'telegram_unlinked_reply',
    })
    .onConflictDoUpdate({
      target: [rateLimits.externalSubject, rateLimits.actionKey],
      set: {
        windowStart: sql`CASE WHEN ${expired}
          THEN statement_timestamp() ELSE ${rateLimits.windowStart} END`,
        count: sql`CASE WHEN ${expired}
          THEN 1 ELSE LEAST(${rateLimits.count} + 1, 6) END`,
      },
    })
    .returning({ count: rateLimits.count });
  return row.count <= 5;
}
