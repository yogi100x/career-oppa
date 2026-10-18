import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';
import { users } from './schema';

export const telegramLinks = pgTable(
  'telegram_links',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    telegramUserId: text('telegram_user_id').notNull(),
    chatId: text('chat_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    remindersEnabled: boolean('reminders_enabled').notNull().default(true),
  },
  (table) => [
    uniqueIndex('telegram_links_telegram_user_unique').on(table.telegramUserId),
    index('telegram_links_chat_idx').on(table.chatId),
  ],
);

export const telegramLinkCodes = pgTable(
  'telegram_link_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('telegram_link_codes_user_idx').on(table.userId)],
);

export type TelegramLink = typeof telegramLinks.$inferSelect;
export type TelegramLinkCode = typeof telegramLinkCodes.$inferSelect;
