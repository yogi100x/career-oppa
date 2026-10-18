import { describe, expect, it } from 'vitest';
import {
  COACH_DAILY_MESSAGE_LIMIT,
  COACH_DAILY_WINDOW_MS,
  COACH_HISTORY_CHARACTER_LIMIT,
  COACH_HISTORY_MESSAGE_LIMIT,
  COACH_MESSAGE_MAX_CHARS,
  COACH_MINUTE_MESSAGE_LIMIT,
  coachChatSchema,
} from '@career-workspace/contracts';
import { trimCoachHistory } from './coach';

describe('shared coach limits', () => {
  it('publishes the same named allowance for both channels', () => {
    expect(COACH_DAILY_MESSAGE_LIMIT).toBe(20);
    expect(COACH_DAILY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(COACH_MESSAGE_MAX_CHARS).toBe(1000);
    expect(COACH_HISTORY_MESSAGE_LIMIT).toBe(6);
    expect(COACH_HISTORY_CHARACTER_LIMIT).toBe(6000);
    expect(COACH_MINUTE_MESSAGE_LIMIT).toBe(10);
  });

  it('accepts 1,000 character messages and rejects longer ones', () => {
    expect(
      coachChatSchema.safeParse({ message: 'x'.repeat(1000) }).success,
    ).toBe(true);
    expect(
      coachChatSchema.safeParse({ message: 'x'.repeat(1001) }).success,
    ).toBe(false);
  });

  it('keeps the latest six history messages within 6,000 characters', () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `${index}:` + 'x'.repeat(1198),
    }));
    const result = trimCoachHistory(history);
    expect(result).toHaveLength(5);
    expect(result.map(({ content }) => content.slice(0, 2))).toEqual([
      '3:',
      '4:',
      '5:',
      '6:',
      '7:',
    ]);
    expect(
      result.reduce((sum, { content }) => sum + content.length, 0),
    ).toBeLessThanOrEqual(6000);
  });

  it('drops whole messages at a non-word-aligned boundary', () => {
    const old = {
      role: 'assistant',
      content: 'Here is some earlier advice. '.repeat(73),
    };
    const recent = [
      { role: 'user', content: 'How should I prepare?' },
      {
        role: 'assistant',
        content: 'Practise explaining your project clearly. '.repeat(140),
      },
      { role: 'user', content: 'Can you give me one example?' },
    ];
    const history = [old, ...recent];
    expect(trimCoachHistory(history)).toEqual(recent);
    expect(history[0]).toEqual(old);
  });

  it('drops an oversized message rather than returning a misleading fragment', () => {
    expect(
      trimCoachHistory([
        {
          role: 'assistant',
          content: 'Important context: ' + 'x'.repeat(6000),
        },
      ]),
    ).toEqual([]);
    const current = { role: 'user', content: 'What should I do next?' };
    expect(
      trimCoachHistory([
        { role: 'assistant', content: 'x'.repeat(6001) },
        current,
      ]),
    ).toEqual([current]);
  });

  it('retains exactly six complete messages at the character boundary', () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({
      content: `${index}:` + 'a'.repeat(998),
    }));
    expect(trimCoachHistory(messages)).toEqual(messages.slice(1));
  });
});
