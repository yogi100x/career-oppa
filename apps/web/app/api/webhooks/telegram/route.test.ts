import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  receiveTelegramUpdate,
  drainTelegramUpdates,
  sendTelegramReply,
  sendTelegramTyping,
  acknowledgeTelegramCallback,
  afterTasks,
} = vi.hoisted(() => ({
  receiveTelegramUpdate: vi.fn(),
  drainTelegramUpdates: vi.fn(),
  sendTelegramReply: vi.fn(),
  sendTelegramTyping: vi.fn(),
  acknowledgeTelegramCallback: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({
  after: (task: () => unknown) => afterTasks.push(task),
}));
vi.mock('@career-workspace/core/telegram-bot', () => ({
  receiveTelegramUpdate,
  drainTelegramUpdates,
}));
vi.mock('../../../../lib/telegram-sdk', () => ({
  sendTelegramReply,
  sendTelegramTyping,
  acknowledgeTelegramCallback,
}));

import { POST } from './route';
import { normalizeTelegramUpdate } from '../../../../lib/telegram-normalize';

const secret = 'unit-test-webhook-secret';
const headers = { 'x-telegram-bot-api-secret-token': secret };

function request(body: unknown, requestHeaders = headers) {
  return new Request('https://career-workspace.test/api/webhooks/telegram', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  afterTasks.length = 0;
  process.env.TELEGRAM_WEBHOOK_SECRET = secret;
  receiveTelegramUpdate.mockResolvedValue({ queued: false });
  drainTelegramUpdates.mockResolvedValue(undefined);
});

describe('Telegram webhook route', () => {
  it('rejects a missing or incorrect Telegram secret before reading updates', async () => {
    const response = await POST(
      request({ update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'wrong' }),
    );

    expect(response.status).toBe(401);
    expect(receiveTelegramUpdate).not.toHaveBeenCalled();
  });

  it('ignores group and channel messages before passing them to core', async () => {
    const response = await POST(
      request({
        update_id: 2,
        message: {
          chat: { id: -100, type: 'supergroup' },
          from: { id: 20 },
          text: 'ignored',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(receiveTelegramUpdate).not.toHaveBeenCalled();
  });

  it('passes private messages into the durable core receiver then schedules its drain', async () => {
    receiveTelegramUpdate.mockResolvedValue({ queued: true });
    const response = await POST(
      request({
        update_id: 45,
        message: {
          chat: { id: 123, type: 'private' },
          from: { id: 123 },
          text: '/roles',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(receiveTelegramUpdate).toHaveBeenCalledWith(
      {
        updateId: 45,
        chatId: '123',
        telegramUserId: '123',
        text: '/roles',
      },
      { send: sendTelegramReply },
    );
    expect(afterTasks).toHaveLength(1);
    expect(drainTelegramUpdates).not.toHaveBeenCalled();
    await afterTasks[0]!();
    expect(drainTelegramUpdates).toHaveBeenCalledWith({
      send: sendTelegramReply,
      typing: sendTelegramTyping,
      limit: 1,
    });
  });

  it('normalizes SDK inline button callbacks without exposing raw update content', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 46,
        callback_query: {
          id: 'callback-1',
          from: { id: 123 },
          data: 'chat:{"a":"review:yes"}',
          message: { chat: { id: 123, type: 'private' } },
        },
      }),
    ).toEqual({
      updateId: 46,
      chatId: '123',
      telegramUserId: '123',
      text: '',
      callbackQueryId: 'callback-1',
      callbackData: 'review:yes',
    });
  });

  it('schedules callback acknowledgement and a drain when core accepts the update', async () => {
    receiveTelegramUpdate.mockResolvedValue({ queued: true });
    await POST(
      request({
        update_id: 47,
        callback_query: {
          id: 'callback-2',
          from: { id: 123 },
          data: 'chat:{"a":"apply:yes"}',
          message: { chat: { id: 123, type: 'private' } },
        },
      }),
    );

    expect(afterTasks).toHaveLength(2);
    await Promise.all(afterTasks.map((task) => task()));
    expect(acknowledgeTelegramCallback).toHaveBeenCalledWith('callback-2');
  });

  it('acknowledges a callback that core does not queue, such as an unlinked press', async () => {
    receiveTelegramUpdate.mockResolvedValue({ queued: false });
    await POST(
      request({
        update_id: 48,
        callback_query: {
          id: 'callback-3',
          from: { id: 123 },
          data: 'chat:{"a":"review:yes"}',
          message: { chat: { id: 123, type: 'private' } },
        },
      }),
    );

    expect(afterTasks).toHaveLength(1);
    await Promise.all(afterTasks.map((task) => task()));
    expect(acknowledgeTelegramCallback).toHaveBeenCalledWith('callback-3');
    expect(drainTelegramUpdates).not.toHaveBeenCalled();
  });
});
