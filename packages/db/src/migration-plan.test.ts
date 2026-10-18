import { describe, expect, it } from 'vitest';
import { getPendingMigrations } from './migration-plan';

describe('migration gap planning', () => {
  const entries = [
    { idx: 29, when: 290, tag: '0029' },
    { idx: 30, when: 300, tag: '0030' },
    { idx: 31, when: 310, tag: '0031' },
    { idx: 32, when: 320, tag: '0032' },
    { idx: 33, when: 330, tag: '0033' },
  ];

  it('applies missing older journal entries even when a later timestamp is recorded', () => {
    expect(getPendingMigrations(entries, new Set([290, 320, 330])).map((entry) => entry.tag)).toEqual([
      '0030',
      '0031',
    ]);
  });

  it('returns no work on the next run after the missing entries are recorded', () => {
    expect(getPendingMigrations(entries, new Set([290, 300, 310, 320, 330]))).toEqual([]);
  });
});
