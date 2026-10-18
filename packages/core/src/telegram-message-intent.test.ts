import { describe, expect, it } from 'vitest';
import { messageIntent } from './telegram-commands';

describe('Telegram message intent', () => {
  it('routes a clear multi-line question about requirements to the coach', () => {
    expect(
      messageIntent(
        'Can you help me understand the requirements?\nI am not sure what experience they mean.',
      ),
    ).toBe('question');
  });

  it('keeps a multi-line job description on the job review path', () => {
    expect(
      messageIntent(
        'We are hiring a junior analyst.\nResponsibilities include preparing reports.\nRequirements include Excel experience.',
      ),
    ).toBe('job');
  });

  it('keeps job URLs on the job review path', () => {
    expect(messageIntent('https://jobs.example/role')).toBe('job');
  });
});
