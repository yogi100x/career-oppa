import { describe, expect, it } from 'vitest';
import { me } from './me';

describe('signed-in account contract', () => {
  it('accepts account details without age confirmation', () => {
    expect(
      me.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        role: 'candidate',
        coachId: 'coach',
        email: null,
      }).success,
    ).toBe(true);
  });
  it('rejects unsupported account roles', () => {
    expect(
      me.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        role: 'owner',
        coachId: 'coach',
      }).success,
    ).toBe(false);
  });
});
