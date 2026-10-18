import { z } from 'zod';

export const COACH_DAILY_MESSAGE_LIMIT = 20;
export const COACH_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COACH_MESSAGE_MAX_CHARS = 1000;
export const COACH_HISTORY_MESSAGE_LIMIT = 6;
export const COACH_HISTORY_CHARACTER_LIMIT = 6000;
export const COACH_OUTPUT_TOKEN_LIMIT = 700;
export const COACH_MINUTE_MESSAGE_LIMIT = 10;
export const COACH_GENERATION_TIMEOUT_MS = 45_000;
export const COACH_PENDING_STALE_MS = 10 * 60_000;

export function trimCoachHistory<T extends { content: string }>(messages: T[]) {
  const recent = messages.slice(-COACH_HISTORY_MESSAGE_LIMIT);
  let characters = recent.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  while (recent.length && characters > COACH_HISTORY_CHARACTER_LIMIT) {
    characters -= recent.shift()!.content.length;
  }
  return recent;
}

export const coachChatSchema = z
  .object({
    message: z.string().trim().min(1).max(COACH_MESSAGE_MAX_CHARS),
    opportunityId: z.uuid().optional(),
  })
  .strict();
export const confirmCoachProposalSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();
