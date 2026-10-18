import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  drain: vi.fn(),
  remind: vi.fn(),
  send: vi.fn(),
  typing: vi.fn(),
}));
vi.mock('@career-workspace/core/telegram-bot', () => ({
  drainTelegramUpdates: mocks.drain,
}));
vi.mock('@career-workspace/core/telegram-reminders', () => ({
  sendDueTelegramReminders: mocks.remind,
}));
vi.mock('../../../../lib/telegram-sdk', () => ({
  sendTelegramReply: mocks.send,
  sendTelegramTyping: mocks.typing,
}));
import { GET } from './route';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('Telegram schedule authentication', () => {
  it('requires a configured schedule secret before doing work', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect(
      (await GET(new Request('http://localhost/api/cron/telegram'))).status,
    ).toBe(503);
    expect(mocks.drain).not.toHaveBeenCalled();
  });
  it('rejects a wrong secret and recovers queued work before sending reminders with a valid secret', async () => {
    vi.stubEnv('CRON_SECRET', 'local-test-secret');
    expect(
      (await GET(new Request('http://localhost/api/cron/telegram'))).status,
    ).toBe(401);
    expect(mocks.remind).not.toHaveBeenCalled();
    expect(
      (
        await GET(
          new Request('http://localhost/api/cron/telegram', {
            headers: { authorization: 'Bearer local-test-secret' },
          }),
        )
      ).status,
    ).toBe(200);
    expect(mocks.drain).toHaveBeenCalledWith({
      send: mocks.send,
      typing: mocks.typing,
      limit: 3,
    });
    expect(mocks.remind).toHaveBeenCalledWith({ send: mocks.send });
  });
});
