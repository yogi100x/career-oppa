import { timingSafeEqual } from 'node:crypto';
import { after } from 'next/server';
import { normalizeTelegramUpdate } from '../../../../lib/telegram-normalize';
import {
  drainTelegramUpdates,
  receiveTelegramUpdate,
} from '@career-workspace/core/telegram-bot';
import {
  acknowledgeTelegramCallback,
  sendTelegramReply,
  sendTelegramTyping,
} from '../../../../lib/telegram-sdk';

export const runtime = 'nodejs';
export const maxDuration = 60;
const maximumWebhookBodyBytes = 128 * 1024;

function hasValidSecret(provided: string | null, expected: string | undefined) {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

export async function POST(request: Request): Promise<Response> {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (
    !hasValidSecret(
      request.headers.get('x-telegram-bot-api-secret-token'),
      expectedSecret,
    )
  ) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const contentLength = Number(request.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > maximumWebhookBodyBytes
  ) {
    return Response.json({ ok: true });
  }

  let payload: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, 'utf8') > maximumWebhookBodyBytes) {
      return Response.json({ ok: true });
    }
    payload = JSON.parse(body);
  } catch {
    // A malformed update cannot become valid on Telegram's retry.
    return Response.json({ ok: true });
  }

  const update = normalizeTelegramUpdate(payload);
  if (!update) return Response.json({ ok: true });

  try {
    const result = await receiveTelegramUpdate(update, {
      send: sendTelegramReply,
    });
    // Answer every button press, including unlinked or rate-limited ones, so the spinner stops.
    if (update.callbackQueryId) {
      after(() => acknowledgeTelegramCallback(update.callbackQueryId!));
    }
    if (result.queued) {
      after(() =>
        drainTelegramUpdates({
          send: sendTelegramReply,
          typing: sendTelegramTyping,
          limit: 1,
        }).catch(() => undefined),
      );
    }
    return Response.json({ ok: true });
  } catch {
    // Returning an error asks Telegram to retry the update; no message or key is logged.
    return Response.json({ ok: false }, { status: 503 });
  }
}
