import { describe, expect, it } from 'vitest';
import { contractsPackageName } from './index';

describe('contracts package setup', () => {
  it('exposes the package identifier', () => {
    expect(contractsPackageName).toBe('@career-workspace/contracts');
  });
});
