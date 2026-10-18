import { describe, expect, it } from 'vitest';
import { clerkTestUserParams } from './clerk-test-user';

describe('Clerk temporary browser user parameters', () => {
  it.each(['cw_e2e_a_abc123', 'cw_extension_abc123'])(
    'supplies the required test email for %s without a password',
    (username) => {
      expect(clerkTestUserParams(username)).toEqual({
        username,
        emailAddress: [`${username}+clerk_test@example.com`],
        skipPasswordRequirement: true,
      });
    },
  );
  it('rejects non-test usernames', () => {
    expect(() => clerkTestUserParams('real_user')).toThrow('test usernames');
  });
});
