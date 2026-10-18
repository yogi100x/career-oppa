import { ApiError, checkRateLimit } from '@career-workspace/core';
import {
  createTelegramLinkCode,
  disconnectTelegram,
  getTelegramLink,
} from '@career-workspace/core/telegram-links';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';

export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => {
    const link = await getTelegramLink(user.id);
    // Telegram identity and chat identifiers stay on the server.
    return { linked: Boolean(link), linkedAt: link?.linkedAt ?? null };
  },
});

export const POST = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => {
    const limit = await checkRateLimit(user.id, 'telegram_link_code', {
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed)
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Wait a little before creating another Telegram link.',
      );
    return createTelegramLinkCode(user.id);
  },
});

export const DELETE = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => {
    await disconnectTelegram(user.id);
    return { disconnected: true };
  },
});
