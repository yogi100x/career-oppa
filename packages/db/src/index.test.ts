import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { events, users } from './schema';

describe('database package setup', () => {
  it('exports the foundation tables', () => {
    expect(getTableName(users)).toBe('users');
    expect(getTableName(events)).toBe('events');
  });
});
