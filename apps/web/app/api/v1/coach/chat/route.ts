import {
  COACH_MINUTE_MESSAGE_LIMIT,
  coachChatSchema,
} from '@career-workspace/contracts';
import { ApiError, checkRateLimit } from '@career-workspace/core';
import { and, eq } from 'drizzle-orm';
import { coachMessages, getDatabase } from '@career-workspace/db';
import {
  beginCoachMessage,
  failCoachMessage,
  finishCoachMessage,
  listCoachMessages,
  trimCoachHistory,
} from '@career-workspace/core/coach';
import { getOpportunity } from '@career-workspace/core/roles';
import { coachToolset } from '@career-workspace/core/coach-toolset';
import { streamCoach } from '@career-workspace/adapters/ai/coach';
import {
  authenticateApi,
  logApiFailure,
  manualRouteAccessError,
  withRequestId,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  let messageId: string | undefined;
  let accountId: string | undefined;
  try {
    const user = await authenticateApi(request);
    const accessError = manualRouteAccessError(user);
    if (!user) return accessError!;
    if (accessError) return accessError;
    accountId = user.id;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, 'INVALID_INPUT', 'Send a valid message.');
    }
    const parsed = coachChatSchema.safeParse(body);
    const key = request.headers.get('idempotency-key') ?? '';
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Enter a coach message up to 1,000 characters. Shorten it if needed, or paste a job in My roles for a separate review.',
      );
    if (!key)
      throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
    if (parsed.data.opportunityId)
      await getOpportunity(user.id, parsed.data.opportunityId);
    if (
      !process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY.startsWith('REPLACE_WITH_')
    )
      throw new ApiError(
        503,
        'AI_NOT_CONFIGURED',
        'Your coach is not connected to AI yet. No message allowance was used.',
      );
    const database = getDatabase();
    const [existing] = await database
      .select({ id: coachMessages.id, status: coachMessages.status })
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.userId, user.id),
          eq(coachMessages.requestKey, key),
          eq(coachMessages.role, 'user'),
        ),
      )
      .limit(1);
    const [cachedReply] = existing?.status === 'completed'
      ? await database
          .select({ id: coachMessages.id })
          .from(coachMessages)
          .where(
            and(
              eq(coachMessages.userId, user.id),
              eq(coachMessages.replyToId, existing.id),
              eq(coachMessages.role, 'assistant'),
              eq(coachMessages.status, 'completed'),
            ),
          )
          .limit(1)
      : [];
    if (!cachedReply) {
      const limit = await checkRateLimit(user.id, 'coach_chat', {
        limit: COACH_MINUTE_MESSAGE_LIMIT,
        windowMs: 60_000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before another coach message.',
        );
    }
    const started = await beginCoachMessage(user.id, parsed.data, key);
    if (started.reply)
      return new Response(started.reply.content, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    messageId = started.message.id;
    const history = trimCoachHistory((await listCoachMessages(user.id))
      .filter((item) => item.status === 'completed' || item.id === messageId)
      .map((item) => ({
        role: item.role as 'user' | 'assistant',
        content:
          item.id === started.message.id && parsed.data.opportunityId
            ? `${item.content}\n<CONTEXT_DATA>${JSON.stringify({ activeOpportunityId: parsed.data.opportunityId })}</CONTEXT_DATA>`
            : item.content,
      })));
    const response = await streamCoach({
      coachId: started.coachId,
      messages: history,
      tools: coachToolset(user.id),
      signal: request.signal,
      onFinish: async (text, metadata) => {
        await finishCoachMessage(user.id, started.message.id, text, metadata);
      },
      onError: async () => {
        await failCoachMessage(user.id, started.message.id);
      },
    });
    return response.toTextStreamResponse({
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (messageId && accountId)
      await failCoachMessage(accountId, messageId).catch(() => undefined);
    const safe =
      error instanceof ApiError
        ? error
        : new ApiError(
            502,
            'COACH_UNAVAILABLE',
            'Your coach could not answer. Try again.',
          );
    const response = Response.json(
      { error: { code: safe.code, message: safe.message } },
      { status: safe.status, headers: { 'Cache-Control': 'no-store' } },
    );
    return error instanceof ApiError
      ? response
      : withRequestId(response, logApiFailure(request, safe.code));
  }
}
