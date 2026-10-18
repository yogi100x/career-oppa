import { describe, expect, it } from 'vitest';
import { sanitizeWorkspaceReturnPath } from './workspace-return-path';

describe('sanitizeWorkspaceReturnPath', () => {
  it('keeps workspace role paths and their query strings', () => {
    expect(
      sanitizeWorkspaceReturnPath('/workspace/roles/role_123?tab=resume'),
    ).toBe('/workspace/roles/role_123?tab=resume');
  });

  it('rejects absolute, external, and path-escaping destinations', () => {
    for (const value of [
      'https://attacker.example/workspace',
      'http://career-workspace.local/workspace/roles/role_123',
      '//attacker.example/workspace',
      '/workspace/../admin',
      '/workspace/%2e%2e/admin',
      '/workspace\\\\attacker.example',
      '/workspace/%00roles',
    ]) {
      expect(sanitizeWorkspaceReturnPath(value)).toBe('/workspace');
    }
  });

  it('defaults to the workspace when no safe return path is provided', () => {
    expect(sanitizeWorkspaceReturnPath(undefined)).toBe('/workspace');
    expect(sanitizeWorkspaceReturnPath('/sign-in')).toBe('/workspace');
  });

  it('does not accept nested completion URLs as return paths', () => {
    expect(
      sanitizeWorkspaceReturnPath(
        '/auth/complete?next=%2Fworkspace%2Froles%2Frole_123',
      ),
    ).toBe('/workspace');
  });
});
