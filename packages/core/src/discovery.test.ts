import { describe, expect, it } from 'vitest';
import { saveDiscoveredJob } from './discovery';

describe('discovery save input', () => {
  it('returns not found for a malformed discovery ID before opening the database', async () => {
    await expect(saveDiscoveredJob('user-id', 'not-a-uuid')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});
