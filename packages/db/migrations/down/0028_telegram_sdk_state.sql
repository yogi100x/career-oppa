-- Only after stopping the Telegram worker. Removes only SDK state.
DROP TABLE IF EXISTS chat_state_queues, chat_state_lists, chat_state_cache, chat_state_locks, chat_state_subscriptions;
