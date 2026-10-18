import { and, eq, lt, or } from 'drizzle-orm';
import { getDatabase, tasks, type Database } from '@career-workspace/db';
import {
  consumeTelegramLinkCode,
  disconnectTelegram,
  getTelegramLink,
  getUserForTelegram,
  sendIfTelegramLinked,
} from './telegram-links';
import { checkRateLimit } from './rate-limit';
import { allowUnlinkedTelegramReply } from './unlinked-telegram-rate-limit';
import type { TelegramCoachOptions } from './telegram-coach';
import { handleTelegramCommand } from './telegram-commands';
import { handleTelegramHandoff } from './telegram-reminders';
import type {
  TelegramReply,
  TelegramSend,
  TelegramUpdate,
} from './telegram-types';

export type {
  TelegramReply,
  TelegramSend,
  TelegramUpdate,
} from './telegram-types';
type Options = {
  database?: Database;
  send: TelegramSend;
  appUrl?: string;
} & Pick<TelegramCoachOptions, 'stream' | 'typing'>;
type Handler = (
  userId: string,
  update: TelegramUpdate,
  database: Database,
  appUrl: string,
) => Promise<TelegramReply[]>;

function appOrigin(value = process.env.APP_URL ?? 'http://localhost:3000') {
  return new URL(value).origin;
}

/** Persist before acknowledging Telegram; no raw link code enters the task queue. */
export async function receiveTelegramUpdate(
  update: TelegramUpdate,
  options: Options,
) {
  const database = options.database ?? getDatabase();
  if (
    !Number.isSafeInteger(update.updateId) ||
    update.updateId < 0 ||
    !/^[1-9][0-9]{0,19}$/.test(update.telegramUserId) ||
    update.telegramUserId !== update.chatId
  )
    return { queued: false };
  const command = update.text
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .split('@')[0];
  if (command === '/start') {
    const code = update.text.split(/\s+/)[1];
    const result = code
      ? await consumeTelegramLinkCode(
          code,
          update.telegramUserId,
          update.chatId,
          { database },
        )
      : null;
    const linked = await getUserForTelegram(
      update.telegramUserId,
      update.chatId,
      database,
    );
    const status = result?.status;
    if (
      !linked &&
      !(await allowUnlinkedTelegramReply(update.telegramUserId, database))
    )
      return { queued: false };
    await options.send(update.chatId, {
      text: linked
        ? status === 'identity_conflict'
          ? 'This Telegram account is already connected to a Career Workspace account. To connect a different account, send /stop first, then use a new link from your web profile.'
          : 'Send me a job link for a fit review.\nOr ask me for matching roles.'
        : status === 'expired'
          ? 'That link has expired. Create a new link in your web profile.'
          : status === 'already_used'
            ? 'That link has already been used. Create a new link in your web profile.'
            : status === 'already_linked'
              ? 'Your web account is already connected to another Telegram account. Disconnect it in your web profile first, then create a new link.'
              : 'Connect your account first using Connect Telegram in your web profile.',
      ...(!linked
        ? {
            buttons: [
              {
                text: 'Open your profile',
                url: `${appOrigin(options.appUrl)}/workspace/profile`,
              },
            ],
          }
        : {}),
    });
    return { queued: false };
  }
  const user = await getUserForTelegram(
    update.telegramUserId,
    update.chatId,
    database,
  );
  if (!user) {
    if (!(await allowUnlinkedTelegramReply(update.telegramUserId, database)))
      return { queued: false };
    await options.send(update.chatId, {
      text: 'Connect your account first.',
      buttons: [
        {
          text: 'Connect Telegram',
          url: `${appOrigin(options.appUrl)}/workspace/profile`,
        },
      ],
    });
    return { queued: false };
  }
  if (command === '/stop') {
    await disconnectTelegram(user.id, database);
    await options.send(update.chatId, {
      text: 'Disconnected. Telegram reminders have stopped. You can connect again from your web profile.',
    });
    return { queued: false };
  }
  const key = `telegram:${update.updateId}`;
  const [existing] = await database
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.idempotencyKey, key));
  if (existing) return { queued: true };
  const limit = await checkRateLimit(
    user.id,
    'telegram_messages',
    { limit: 30, windowMs: 60_000 },
    database,
  );
  if (!limit.allowed) {
    await options.send(update.chatId, {
      text: 'Please wait a minute before sending another command.',
    });
    return { queued: false };
  }
  const link = await getTelegramLink(user.id, database);
  if (!link) return { queued: false };
  await database
    .insert(tasks)
    .values({
      userId: user.id,
      kind: 'telegram_update',
      idempotencyKey: key,
      input: { ...update, linkedAt: link.linkedAt.toISOString() },
    })
    .onConflictDoNothing();
  return { queued: true };
}

async function defaultHandler(
  userId: string,
  update: TelegramUpdate,
  database: Database,
  appUrl: string,
  coachOptions: Pick<TelegramCoachOptions, 'stream' | 'typing'> = {},
): Promise<TelegramReply[]> {
  if (update.callbackData?.startsWith('a:'))
    return handleTelegramHandoff(userId, update.callbackData, database);
  return handleTelegramCommand(userId, update, {
    database,
    appUrl,
    ...coachOptions,
  });
}

/** Leases also allow the scheduled drain to recover interrupted server instances. */
export async function drainTelegramUpdates(
  options: Options & { handle?: Handler; limit?: number },
) {
  const database = options.database ?? getDatabase();
  for (let count = 0; count < (options.limit ?? 10); count++) {
    const task = await database.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.kind, 'telegram_update'),
            lt(tasks.attempts, 5),
            or(
              eq(tasks.status, 'queued'),
              and(
                eq(tasks.status, 'running'),
                // Wait beyond the maximum worker run (5m) plus its review lease (5m).
                // Otherwise recovery can see its own review as busy and stop retrying it.
                lt(tasks.updatedAt, new Date(Date.now() - 11 * 60_000)),
              ),
            ),
          ),
        )
        .orderBy(tasks.createdAt)
        .for('update', { skipLocked: true })
        .limit(1);
      if (!candidate) return null;
      await tx
        .update(tasks)
        .set({
          status: 'running',
          attempts: candidate.attempts + 1,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, candidate.id));
      return candidate;
    });
    if (!task) return;
    const update = task.input as TelegramUpdate & { linkedAt: string };
    try {
      const currentLink = await getTelegramLink(task.userId, database);
      const user = await getUserForTelegram(
        update.telegramUserId,
        update.chatId,
        database,
      );
      if (
        !user ||
        user.id !== task.userId ||
        currentLink?.linkedAt.toISOString() !== update.linkedAt
      ) {
        await database.delete(tasks).where(eq(tasks.id, task.id));
        continue;
      }
      const saved = task.output as {
        replies?: TelegramReply[];
        sent?: number;
      } | null;
      const replies =
        saved?.replies ??
        (await (
          options.handle ??
          ((userId, update, db, url) =>
            defaultHandler(userId, update, db, url, options))
        )(task.userId, update, database, appOrigin(options.appUrl)));
      let sent = saved?.sent ?? 0;
      await database
        .update(tasks)
        .set({ output: { replies, sent }, updatedAt: new Date() })
        .where(eq(tasks.id, task.id));
      for (; sent < replies.length; sent++) {
        if (
          !(await sendIfTelegramLinked(
            task.userId,
            update.linkedAt,
            replies[sent],
            options.send,
            database,
          ))
        )
          break;
        await database
          .update(tasks)
          .set({ output: { replies, sent: sent + 1 }, updatedAt: new Date() })
          .where(eq(tasks.id, task.id));
      }
      await database
        .update(tasks)
        .set({
          status: 'succeeded',
          input: {},
          output: {},
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
    } catch {
      // Only a stable category is stored: never exception messages, tokens or pasted text.
      await database
        .update(tasks)
        .set({
          status: task.attempts >= 4 ? 'failed' : 'running',
          error: 'telegram_delivery_or_processing_failed',
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
    }
  }
}
