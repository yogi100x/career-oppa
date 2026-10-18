import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getCurrentUser,
  isClerkConfigured,
  getTelegramLink,
  disconnectTelegram,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isClerkConfigured: vi.fn(),
  getTelegramLink: vi.fn(),
  disconnectTelegram: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../../../lib/current-user', () => ({ getCurrentUser }));
vi.mock('../../../../../lib/clerk-config', () => ({ isClerkConfigured }));
vi.mock('@career-workspace/core/telegram-links', () => ({
  createTelegramLinkCode: vi.fn(),
  disconnectTelegram,
  getTelegramLink,
}));

import { DELETE, GET } from './route';

describe('Telegram link routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isClerkConfigured.mockReturnValue(true);
  });

  it('does not reveal link status to a signed-out visitor', async () => {
    getCurrentUser.mockResolvedValue(null);
    const response = await GET(
      new Request('http://localhost/api/v1/telegram/link'),
    );
    expect(response.status).toBe(401);
    expect(getTelegramLink).not.toHaveBeenCalled();
  });

  it('does not allow an account pending deletion to disconnect a link', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'user-a',
      deletionRequestedAt: new Date(),
    });
    const response = await DELETE(
      new Request('http://localhost/api/v1/telegram/link', {
        method: 'DELETE',
      }),
    );
    expect(response.status).toBe(403);
    expect(disconnectTelegram).not.toHaveBeenCalled();
  });

  it('returns only linked status and date, not Telegram identity fields', async () => {
    getCurrentUser.mockResolvedValue({ id: 'user-a' });
    getTelegramLink.mockResolvedValue({
      userId: 'user-a',
      telegramUserId: 'private-id',
      chatId: 'private-chat',
      linkedAt: new Date('2026-10-11T10:00:00.000Z'),
    });
    const response = await GET(
      new Request('http://localhost/api/v1/telegram/link'),
    );
    expect(await response.json()).toEqual({
      data: { linked: true, linkedAt: '2026-10-11T10:00:00.000Z' },
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
