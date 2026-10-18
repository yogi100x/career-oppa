import type { TelegramUpdate } from '@career-workspace/core/telegram-bot';

function telegramId(value: unknown): string | null {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return String(value);
  return null;
}

function decodeCallbackData(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('chat:')) return value;

  try {
    const parsed: unknown = JSON.parse(value.slice('chat:'.length));
    if (!parsed || typeof parsed !== 'object') return undefined;
    const payload = parsed as { v?: unknown; a?: unknown };
    if (typeof payload.v === 'string') return payload.v;
    return typeof payload.a === 'string' ? payload.a : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const update = value as {
    update_id?: unknown;
    message?: {
      chat?: { id?: unknown; type?: unknown };
      from?: { id?: unknown };
      text?: unknown;
    };
    callback_query?: {
      id?: unknown;
      from?: { id?: unknown };
      data?: unknown;
      message?: { chat?: { id?: unknown; type?: unknown } };
    };
  };
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0)
    return null;

  const message = update.message;
  if (message) {
    if (message.chat?.type !== 'private') return null;
    const chatId = telegramId(message.chat.id);
    const telegramUserId = telegramId(message.from?.id);
    if (!chatId || !telegramUserId || chatId !== telegramUserId) return null;
    return {
      updateId: update.update_id as number,
      chatId,
      telegramUserId,
      text: typeof message.text === 'string' ? message.text : '',
    };
  }

  const callback = update.callback_query;
  if (callback) {
    if (callback.message?.chat?.type !== 'private') return null;
    const chatId = telegramId(callback.message.chat.id);
    const telegramUserId = telegramId(callback.from?.id);
    const callbackQueryId =
      typeof callback.id === 'string' ? callback.id : null;
    if (
      !chatId ||
      !telegramUserId ||
      chatId !== telegramUserId ||
      !callbackQueryId
    )
      return null;
    return {
      updateId: update.update_id as number,
      chatId,
      telegramUserId,
      text: '',
      callbackQueryId,
      callbackData: decodeCallbackData(callback.data),
    };
  }

  return null;
}
