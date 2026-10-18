import 'server-only';

import { createDatabase } from '@career-workspace/db';
import { createPostgresState } from '@chat-adapter/state-pg';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import {
  Actions,
  Button,
  Card,
  CardText,
  LinkButton,
  Chat,
  type Logger,
} from 'chat';
import type { TelegramReply } from '@career-workspace/core/telegram-bot';

const silentLogger: Logger = {
  child: () => silentLogger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

let telegramClient:
  | Promise<{
      chat: Chat;
      adapter: ReturnType<typeof createTelegramAdapter>;
    }>
  | undefined;

function createTelegramClient() {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  const testApiUrl = validatedTestApiUrl();
  const botToken = testApiUrl
    ? '123456:local-test-token'
    : process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken || !webhookSecret || !databaseUrl) {
    throw new Error('Telegram bot configuration is incomplete.');
  }

  // Keep the pool warm in serverless while sharing the app's database URL.
  const { pool } = createDatabase(databaseUrl);
  const adapter = createTelegramAdapter({
    botToken,
    mode: 'webhook',
    secretToken: webhookSecret,
    allowUnverifiedWebhooks: false,
    userName: 'CareerOppaBot',
    ...(testApiUrl ? { apiUrl: testApiUrl } : {}),
    logger: silentLogger,
  });
  const chat = new Chat({
    userName: 'CareerOppaBot',
    adapters: { telegram: adapter },
    state: createPostgresState({
      client: pool,
      autoCreateSchema: false,
      keyPrefix: 'career-oppa',
      logger: silentLogger,
    }),
    logger: silentLogger,
  });

  return { chat, adapter };
}

async function getTelegramClient() {
  telegramClient ??= Promise.resolve().then(createTelegramClient);
  const client = await telegramClient;
  await client.chat.initialize();
  return client;
}

/** Card text is parsed as Markdown, so escape it: job text must stay literal, never links or formatting. */
function literalMarkdown(text: string) {
  return text.replace(/[!-/:-@[-`{-~]/g, '\\$&');
}

export function telegramMessage(reply: TelegramReply) {
  if (!reply.buttons?.length) return reply.text;
  return Card({
    children: [
      CardText(literalMarkdown(reply.text)),
      ...reply.buttons.map((button) =>
        Actions([
          button.url
            ? LinkButton({ url: button.url, label: button.text })
            : Button({
                id: button.data ?? 'telegram_action',
                label: button.text,
              }),
        ]),
      ),
    ],
  });
}

export async function sendTelegramReply(
  chatId: string,
  reply: TelegramReply,
): Promise<void> {
  const { adapter } = await getTelegramClient();
  await adapter.postMessage(
    adapter.encodeThreadId({ chatId }),
    telegramMessage(reply),
  );
}

export async function sendTelegramTyping(chatId: string): Promise<void> {
  const { adapter } = await getTelegramClient();
  await adapter.startTyping(adapter.encodeThreadId({ chatId }));
}

/**
 * Telegram's adapter acknowledges callbacks while dispatching their actions,
 * but the webhook route queues directly into the core processor to preserve
 * the original update_id. This small Bot API call only dismisses the button
 * spinner; all bot messages and buttons use Chat SDK's Telegram adapter.
 */
function validatedTestApiUrl(): string | undefined {
  const testApiUrl = process.env.TELEGRAM_TEST_API_URL;
  if (!testApiUrl) return undefined;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Telegram test API URL is only allowed outside production.',
    );
  }

  let databaseName = '';
  let appOrigin = '';
  let apiOrigin = '';
  try {
    databaseName = new URL(process.env.DATABASE_URL ?? '').pathname;
    appOrigin = new URL(process.env.APP_URL ?? '').origin;
    apiOrigin = new URL(testApiUrl).origin;
  } catch {
    throw new Error('Telegram test API configuration is invalid.');
  }
  if (
    databaseName !== '/career_workspace_test' ||
    !['http://localhost:3194', 'http://localhost:3197'].includes(appOrigin) ||
    apiOrigin !== 'http://127.0.0.1:3195'
  ) {
    throw new Error(
      'Telegram test API configuration is restricted to the local test database and stub.',
    );
  }
  return testApiUrl;
}

export async function acknowledgeTelegramCallback(
  callbackQueryId: string,
): Promise<void> {
  const testApiUrl = validatedTestApiUrl();
  const botToken = testApiUrl
    ? '123456:local-test-token'
    : process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !callbackQueryId) return;

  try {
    await fetch(
      `${testApiUrl ?? 'https://api.telegram.org'}/bot${botToken}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
      },
    );
  } catch {
    // A failed spinner acknowledgement must not undo a durably queued update.
  }
}
