import {
  publishingCallbackSchema,
  type PublishingCallback,
} from '@career-workspace/contracts';
import { guardFeature, readFlags } from '@career-workspace/core';
import { verifyZernioSignature } from '@career-workspace/adapters/zernio';
import { recordPublishingCallback } from '@career-workspace/core/publishing';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const disabled = guardFeature(readFlags(process.env), 'publishing');
  if (disabled) return disabled;
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (!secret || secret.startsWith('REPLACE_WITH_'))
    return Response.json(
      {
        error: {
          code: 'WEBHOOK_NOT_CONFIGURED',
          message: 'Publishing callbacks are not configured.',
        },
      },
      { status: 503 },
    );
  const raw = await request.text();
  if (raw.length > 1_000_000)
    return Response.json(
      { error: { code: 'INVALID_PAYLOAD', message: 'Callback is too large.' } },
      { status: 413 },
    );
  if (
    !verifyZernioSignature(
      raw,
      request.headers.get('x-zernio-signature') ??
        request.headers.get('x-late-signature') ??
        '',
      secret,
    )
  )
    return Response.json(
      {
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Callback signature is invalid.',
        },
      },
      { status: 401 },
    );
  let value: PublishingCallback;
  try {
    value = publishingCallbackSchema.parse(JSON.parse(raw));
  } catch {
    return Response.json(
      {
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Callback payload is invalid.',
        },
      },
      { status: 400 },
    );
  }
  const headerId =
    request.headers.get('x-zernio-event-id') ??
    request.headers.get('x-late-event-id');
  if (headerId && headerId !== value.id)
    return Response.json(
      {
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Callback event ID does not match.',
        },
      },
      { status: 400 },
    );
  if (!['post.published', 'post.failed', 'post.partial'].includes(value.event))
    return Response.json({ data: { ignored: true } });
  if (!value.post)
    return Response.json(
      {
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Callback post is missing.',
        },
      },
      { status: 400 },
    );
  try {
    for (const target of value.post.platforms) {
      if (!target.accountId || !['published', 'failed'].includes(target.status))
        continue;
      await recordPublishingCallback(
        `${value.id}:${target.accountId}`,
        value.post.id,
        {
          status: target.status,
          accountId: target.accountId,
          platform: target.platform,
          publicUrl: target.publishedUrl,
        },
      );
    }
    return Response.json({ data: { received: true } });
  } catch {
    return Response.json(
      {
        error: {
          code: 'CALLBACK_SAVE_FAILED',
          message: 'Callback could not be saved. Retry delivery.',
        },
      },
      { status: 500 },
    );
  }
}
