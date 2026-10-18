import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { Logger } from 'chat';

vi.mock('server-only', () => ({}));

import { telegramMessage } from './telegram-sdk';
import { normalizeTelegramUpdate } from './telegram-normalize';

const quiet: Logger = {
  child: () => quiet,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

describe('Telegram message rendering', () => {
  const bodies: Array<Record<string, unknown>> = [];
  const methods: string[] = [];
  let server: Server;
  let apiUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      methods.push(request.url ?? '');
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const result = request.url?.endsWith('/getMe')
          ? {
              id: 1,
              is_bot: true,
              first_name: 'Bot',
              username: 'CareerOppaBot',
            }
          : {
              message_id: bodies.push(body),
              date: 0,
              chat: { id: 1001, type: 'private' },
              text: String(body.text ?? ''),
            };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('keeps untrusted job text literal in messages with buttons', async () => {
    const adapter = createTelegramAdapter({
      botToken: '123456:unit-test-token',
      mode: 'webhook',
      secretToken: 'unit-test-secret',
      userName: 'CareerOppaBot',
      apiUrl,
      logger: quiet,
    });
    const taskId = '7f0c2c4e-8a51-4c3e-9d42-0f6f5b0c1a2b';
    await adapter.postMessage(
      adapter.encodeThreadId({ chatId: '1001' }),
      telegramMessage({
        text: 'Gaps to check\n• Verify [here](https://evil.example) *now* _snake_case_ # 1. done',
        buttons: [{ text: 'Review (1 credit)', data: `review:${taskId}` }],
      }),
    );

    const sent = bodies.at(-1)!;
    const text = String(sent.text);
    // No Markdown link, bold or italic survives: every marker is escaped.
    expect(text).not.toMatch(/(^|[^\\])\[here\]\(/);
    expect(text).toContain('\\[here\\]\\(');
    // A bare address may still be linked, but only with itself as the visible text.
    const links = [...text.matchAll(/(?<!\\)\[([^\]]*)\]\(([^)]*)\)/g)];
    for (const [, label, target] of links)
      expect(label.replace(/\\/g, '')).toBe(target);
    expect(text).toContain('\\*now\\*');
    expect(text).toContain('\\_snake\\_case\\_');
    expect(text).toContain('Gaps to check\n');

    const keyboard = sent.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const data = keyboard.inline_keyboard[0][0].callback_data;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(
      normalizeTelegramUpdate({
        update_id: 1,
        callback_query: {
          id: 'q',
          from: { id: 1001 },
          data,
          message: { chat: { id: 1001, type: 'private' } },
        },
      })?.callbackData,
    ).toBe(`review:${taskId}`);
  });

  it('sends replies without buttons as literal plain text on the wire', async () => {
    const text = '<b>literal</b> *plain* [click](https://evil.example)';
    expect(telegramMessage({ text })).toBe(text);

    const adapter = createTelegramAdapter({
      botToken: '123456:unit-test-token',
      mode: 'webhook',
      secretToken: 'unit-test-secret',
      userName: 'CareerOppaBot',
      apiUrl,
      logger: quiet,
    });
    await adapter.postMessage(
      adapter.encodeThreadId({ chatId: '1001' }),
      telegramMessage({ text }),
    );

    const sent = bodies.at(-1)!;
    expect(methods.at(-1)).toContain('/sendMessage');
    expect(sent.text).toBe(text);
    expect(sent).not.toHaveProperty('parse_mode');
    expect(sent).not.toHaveProperty('entities');
  });

  it('uses the adapter typing action API', async () => {
    const adapter = createTelegramAdapter({
      botToken: '123456:unit-test-token',
      mode: 'webhook',
      secretToken: 'unit-test-secret',
      userName: 'CareerOppaBot',
      apiUrl,
      logger: quiet,
    });
    await adapter.startTyping(adapter.encodeThreadId({ chatId: '1001' }));
    expect(methods.at(-1)).toContain('/sendChatAction');
    expect(bodies.at(-1)).toMatchObject({ chat_id: '1001', action: 'typing' });
  });
});
