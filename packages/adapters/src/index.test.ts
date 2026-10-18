import { describe, expect, it } from 'vitest';
import { adaptersPackageName } from './index';

describe('adapters package setup', () => {
  it('exposes the package identifier', () => {
    expect(adaptersPackageName).toBe('@career-workspace/adapters');
  });
});
