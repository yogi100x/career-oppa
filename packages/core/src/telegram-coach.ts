import { streamCoach } from '@career-workspace/adapters/ai/coach';
import { and, eq } from 'drizzle-orm';
import {
  COACH_MESSAGE_MAX_CHARS,
  COACH_MINUTE_MESSAGE_LIMIT,
} from '@career-workspace/contracts';
import { coachMessages, tasks, type Database } from '@career-workspace/db';
import { ApiError } from './api';
import {
  beginCoachMessage,
  failCoachMessage,
  finishCoachMessage,
  listCoachMessages,
  trimCoachHistory,
} from './coach';
import { checkRateLimit } from './rate-limit';
import {
  coachToolset,
  type CoachDiscoveryResult,
  type CoachSaveProposal,
} from './coach-toolset';
import type { TelegramReply, TelegramUpdate } from './telegram-types';

export type TelegramCoachOptions = {
  database: Database;
  stream?: typeof streamCoach;
  typing?: (chatId: string) => Promise<void>;
  appUrl?: string;
};

/** Preserve Unicode characters and leave room below Telegram's message limit. */
function repliesFor(text: string): TelegramReply[] {
  const replies: TelegramReply[] = [];
  let chunk = '';
  for (const character of text) {
    if (chunk.length + character.length >= 3000) {
      replies.push({ text: chunk });
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) replies.push({ text: chunk });
  return replies;
}

/** Same allowance, history, tools and AI adapter as the web coach. No credit holds. */
export async function handleTelegramCoach(
  userId: string,
  update: TelegramUpdate,
  options: TelegramCoachOptions,
): Promise<TelegramReply[]> {
  const { database } = options;
  let messageId: string | undefined;
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  try {
    if (update.text.trim().length > COACH_MESSAGE_MAX_CHARS)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        `Please shorten your coach message to ${COACH_MESSAGE_MAX_CHARS.toLocaleString('en-GB')} characters or fewer and try again. You can paste a job for its separate review flow.`,
      );
    if (
      !process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY.startsWith('REPLACE_WITH_')
    )
      throw new ApiError(
        503,
        'AI_NOT_CONFIGURED',
        'Your coach is not connected to AI yet. No message allowance was used.',
      );
    const requestKey = `telegram:${update.updateId}`;
    // A completed delivery retry is a replay, so it must not consume another
    // Telegram allowance (or the shared web minute allowance).
    const [cached] = await database
      .select({ id: coachMessages.id })
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.userId, userId),
          eq(coachMessages.requestKey, requestKey),
          eq(coachMessages.role, 'user'),
          eq(coachMessages.status, 'completed'),
        ),
      )
      .limit(1);
    if (cached) {
      const replay = await beginCoachMessage(
        userId,
        { message: update.text },
        requestKey,
        { database },
      );
      if (replay.reply) {
        const [delivery] = await database
          .select({ output: tasks.output })
          .from(tasks)
          .where(
            and(
              eq(tasks.userId, userId),
              eq(tasks.idempotencyKey, `coach-delivery:${replay.message.id}`),
              eq(tasks.kind, 'coach_reply_presentation'),
            ),
          );
        return (
          (delivery?.output as { replies: TelegramReply[] } | null)?.replies ??
          repliesFor(replay.reply.content)
        );
      }
    }
    const limit = await checkRateLimit(
      userId,
      'coach_chat',
      { limit: COACH_MINUTE_MESSAGE_LIMIT, windowMs: 60_000 },
      database,
    );
    if (!limit.allowed)
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Wait a minute before another coach message.',
      );
    // The existing request key records the Telegram origin without a schema change.
    const started = await beginCoachMessage(
      userId,
      { message: update.text },
      requestKey,
      { database },
    );
    if (started.reply) return repliesFor(started.reply.content);
    messageId = started.message.id;
    const history = trimCoachHistory((await listCoachMessages(userId, database))
      .filter((item) => item.status === 'completed' || item.id === messageId)
      .map((item) => ({
        role: item.role as 'user' | 'assistant',
        content: item.content,
      })));
    const typing = () => options.typing?.(update.chatId).catch(() => undefined);
    void typing();
    typingTimer = setInterval(() => void typing(), 4000);
    let completedText: string | undefined;
    let completedReplies: TelegramReply[] | undefined;
    let discoveryResult: CoachDiscoveryResult | undefined;
    const saveProposals = new Map<string, CoachSaveProposal>();
    let streamFailed = false;
    const response = await (options.stream ?? streamCoach)({
      coachId: started.coachId,
      messages: history,
      tools: coachToolset(userId, database, {
        discovery: (result) => {
          discoveryResult = result;
        },
        proposal: (proposal) => {
          saveProposals.set(proposal.id, proposal);
        },
      }),
      // Leave time to save and deliver the response within the webhook's 60s worker.
      signal: AbortSignal.timeout(45_000),
      onFinish: async (text, metadata) => {
        if (streamFailed) return;
        const replies: TelegramReply[] = [];
        if (discoveryResult) {
          if (!discoveryResult.matches.length)
            replies.push({
              text: `${discoveryResult.message}\n${new URL('/workspace/discover', options.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000').toString()}`,
            });
          for (
            let index = 0;
            index < discoveryResult.matches.length;
            index += 5
          ) {
            const group = discoveryResult.matches.slice(index, index + 5);
            const body = group
              .map(
                (job) =>
                  `${job.title} — ${job.company}\n${job.location}\n${job.url}\n${job.reasons.join('; ')}`,
              )
              .join('\n\n');
            replies.push(...repliesFor(`Collected matches\n\n${body}`));
          }
        } else if (!saveProposals.size)
          replies.push(...repliesFor(text.trim()));
        for (const proposal of saveProposals.values()) {
          const body = `${proposal.data.title} — ${proposal.data.company}\n${proposal.data.url}\n${proposal.confirmedAt ? 'This role is already saved.' : 'Save this role to your workspace? Nothing has been saved yet.'}`;
          const chunks = repliesFor(body);
          if (!proposal.confirmedAt)
            chunks[chunks.length - 1].buttons = [
              { text: 'Save this role', data: `s:${proposal.id}` },
            ];
          replies.push(...chunks);
        }
        completedText = replies.map((reply) => reply.text).join('\n\n');
        await database.transaction(async (tx) => {
          await finishCoachMessage(
            userId,
            started.message.id,
            completedText!,
            metadata,
            tx,
          );
          if (discoveryResult || saveProposals.size)
            await tx
              .insert(tasks)
              .values({
                userId,
                kind: 'coach_reply_presentation',
                status: 'succeeded',
                idempotencyKey: `coach-delivery:${started.message.id}`,
                input: {},
                output: { replies },
              })
              .onConflictDoUpdate({
                target: tasks.idempotencyKey,
                set: { output: { replies }, updatedAt: new Date() },
              });
        });
        completedReplies = replies;
      },
      onError: async () => {
        streamFailed = true;
        await failCoachMessage(userId, started.message.id, database);
      },
    });
    // Drain the stream so adapter callbacks run; never send partial or failed output.
    await response.toTextStreamResponse().text();
    if (streamFailed || !completedText) throw new Error('COACH_UNAVAILABLE');
    return completedReplies ?? repliesFor(completedText);
  } catch (error) {
    if (messageId)
      await failCoachMessage(userId, messageId, database).catch(
        () => undefined,
      );
    return [
      {
        text:
          error instanceof ApiError
            ? error.code === 'COACH_DAILY_LIMIT'
              ? `${error.message}\nDiscover: ${new URL('/workspace/discover', options.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000').toString()}\nMy roles: ${new URL('/workspace?view=roles', options.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000').toString()}`
              : error.message
            : 'Your coach could not answer. Try again.',
      },
    ];
  } finally {
    if (typingTimer) clearInterval(typingTimer);
  }
}
