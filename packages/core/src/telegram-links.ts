import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  getDatabase,
  telegramLinkCodes,
  telegramLinks,
  tasks,
  users,
  type Database,
  type TelegramLink,
} from '@career-workspace/db';
import type { TelegramReply } from './telegram-types';

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const BOT_USERNAME = 'CareerOppaBot';

function validPrivateTelegramIdentity(telegramUserId: string, chatId: string) {
  return telegramUserId === chatId && /^[1-9]\d{0,19}$/.test(telegramUserId);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === '23505' || isUniqueViolation(candidate.cause);
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function createTelegramLinkCode(
  userId: string,
  options: { database?: Database; now?: () => Date } = {},
): Promise<{ url: string; expiresAt: Date }> {
  const database = options.database ?? getDatabase();
  const now = options.now?.() ?? new Date();
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + CODE_LIFETIME_MS);
  await database.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletionRequestedAt)))
      .for('update')
      .limit(1);
    if (!account)
      throw new Error('Telegram linking is unavailable for this account.');
    await tx
      .delete(telegramLinkCodes)
      .where(eq(telegramLinkCodes.userId, userId));
    await tx.insert(telegramLinkCodes).values({
      codeHash: hashCode(code),
      userId,
      expiresAt,
      createdAt: now,
    });
  });
  return { url: `https://t.me/${BOT_USERNAME}?start=${code}`, expiresAt };
}

export async function getTelegramLink(
  userId: string,
  database: Database = getDatabase(),
): Promise<TelegramLink | null> {
  const [link] = await database
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, userId))
    .limit(1);
  return link ?? null;
}

export type ConsumeTelegramLinkResult =
  | { status: 'linked'; link: TelegramLink }
  | {
      status:
        | 'invalid'
        | 'expired'
        | 'already_used'
        | 'already_linked'
        | 'identity_conflict';
    };

export async function consumeTelegramLinkCode(
  code: string,
  telegramUserId: string,
  chatId: string,
  options: { database?: Database; now?: () => Date } = {},
): Promise<ConsumeTelegramLinkResult> {
  const database = options.database ?? getDatabase();
  const now = options.now?.() ?? new Date();
  if (!validPrivateTelegramIdentity(telegramUserId, chatId))
    return { status: 'invalid' };
  try {
    return await database.transaction(async (tx) => {
      const [initialCode] = await tx
        .select()
        .from(telegramLinkCodes)
        .where(eq(telegramLinkCodes.codeHash, hashCode(code)))
        .limit(1);
      if (!initialCode) return { status: 'invalid' };

      // All operations lock account first, then code, so disconnect cannot race linking.
      const [account] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, initialCode.userId),
            isNull(users.deletionRequestedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!account) return { status: 'invalid' };
      const [entry] = await tx
        .select()
        .from(telegramLinkCodes)
        .where(eq(telegramLinkCodes.codeHash, initialCode.codeHash))
        .for('update')
        .limit(1);
      if (!entry || entry.userId !== initialCode.userId)
        return { status: 'invalid' };
      if (entry.usedAt) return { status: 'already_used' };
      if (entry.expiresAt <= now) return { status: 'expired' };

      const [byUser, byTelegram] = await Promise.all([
        tx
          .select()
          .from(telegramLinks)
          .where(eq(telegramLinks.userId, entry.userId))
          .limit(1),
        tx
          .select()
          .from(telegramLinks)
          .where(eq(telegramLinks.telegramUserId, telegramUserId))
          .limit(1),
      ]);
      if (byUser.length) return { status: 'already_linked' };
      if (byTelegram.length) return { status: 'identity_conflict' };

      const [link] = await tx
        .insert(telegramLinks)
        .values({
          userId: entry.userId,
          telegramUserId,
          chatId,
          linkedAt: now,
          remindersEnabled: true,
        })
        .returning();
      await tx
        .update(telegramLinkCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(telegramLinkCodes.codeHash, entry.codeHash),
            isNull(telegramLinkCodes.usedAt),
          ),
        );
      return { status: 'linked', link };
    });
  } catch (error) {
    // Unique constraints also protect simultaneous attempts using different codes.
    if (isUniqueViolation(error)) return { status: 'identity_conflict' };
    throw error;
  }
}

export async function disconnectTelegram(
  userId: string,
  database: Database = getDatabase(),
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
      .limit(1);
    await tx.delete(telegramLinks).where(eq(telegramLinks.userId, userId));
    await tx
      .delete(telegramLinkCodes)
      .where(eq(telegramLinkCodes.userId, userId));
    await tx
      .delete(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          or(
            inArray(tasks.kind, ['telegram_update', 'telegram_job']),
            and(
              eq(tasks.kind, 'telegram_reminder'),
              sql`COALESCE(${tasks.output}->>'sent', 'false') <> 'true'`,
            ),
          ),
        ),
      );
  });
}

export async function getUserForTelegram(
  telegramUserId: string,
  chatId: string,
  database: Database = getDatabase(),
): Promise<typeof users.$inferSelect | null> {
  if (!validPrivateTelegramIdentity(telegramUserId, chatId)) return null;
  const [row] = await database
    .select({ user: users })
    .from(telegramLinks)
    .innerJoin(users, eq(users.id, telegramLinks.userId))
    .where(
      and(
        eq(telegramLinks.telegramUserId, telegramUserId),
        eq(telegramLinks.chatId, chatId),
        isNull(users.deletionRequestedAt),
      ),
    )
    .limit(1);
  return row?.user ?? null;
}

/** Serialize delivery with disconnect/deletion so no queued send starts after either completes. */
export async function sendIfTelegramLinked(
  userId: string,
  linkedAt: string,
  reply: TelegramReply,
  send: (
    chatId: string,
    reply: TelegramReply,
    transaction: Database,
  ) => Promise<void>,
  database: Database = getDatabase(),
  requireReminders = false,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletionRequestedAt)))
      .for('update')
      .limit(1);
    if (!user) return false;
    const [link] = await tx
      .select()
      .from(telegramLinks)
      .where(eq(telegramLinks.userId, userId));
    if (
      !link ||
      link.linkedAt.toISOString() !== linkedAt ||
      (requireReminders && !link.remindersEnabled)
    )
      return false;
    await send(link.chatId, reply, tx as unknown as Database);
    return true;
  });
}
