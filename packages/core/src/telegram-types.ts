export type TelegramUpdate = {
  updateId: number;
  chatId: string;
  telegramUserId: string;
  text: string;
  callbackQueryId?: string;
  callbackData?: string;
};

export type TelegramReply = {
  text: string;
  buttons?: Array<{ text: string; data?: string; url?: string }>;
};

export type TelegramSend = (
  chatId: string,
  reply: TelegramReply,
) => Promise<void>;
