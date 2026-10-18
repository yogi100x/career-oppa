import { timingSafeEqual } from 'node:crypto';
import { drainTelegramUpdates } from '@career-workspace/core/telegram-bot';
import { sendDueTelegramReminders } from '@career-workspace/core/telegram-reminders';
import {
  sendTelegramReply,
  sendTelegramTyping,
} from '../../../../lib/telegram-sdk';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret)
    return Response.json(
      { error: 'Scheduler not configured' },
      { status: 503 },
    );
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.get('authorization') ?? '');
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    await drainTelegramUpdates({
      send: sendTelegramReply,
      typing: sendTelegramTyping,
      limit: 3,
    });
    await sendDueTelegramReminders({ send: sendTelegramReply });
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      { error: 'Please retry the scheduled delivery' },
      { status: 503 },
    );
  }
}
