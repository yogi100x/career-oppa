import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const state = vi.hoisted(() => ({
  userId: 'source-health-user' as string | null,
  getDiscoveryHealth: vi.fn(),
}));

vi.mock('../../../../../lib/api-route', async () => {
  const { createApiHandler } = await import('@career-workspace/core');
  return {
    createApiHandler,
    authenticateApi: async () => state.userId ? { id: state.userId, role: 'candidate', ageConfirmedAt: null, deletionRequestedAt: null } : null,
  };
});
vi.mock('@career-workspace/core/discovery', () => ({ getDiscoveryHealth: state.getDiscoveryHealth }));

function request(query = '') {
  return new Request(`http://localhost:3000/api/v1/discovery/sources${query}`);
}

beforeEach(() => {
  state.userId = 'source-health-user';
  state.getDiscoveryHealth.mockReset().mockResolvedValue({ sources: [], sourceTotal: 0, collection: {}, nextOffset: null });
  vi.stubEnv('FEATURE_DISCOVERY', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('discovery source health endpoint', () => {
  it('requires sign-in', async () => {
    state.userId = null;
    expect((await GET(request())).status).toBe(401);
    expect(state.getDiscoveryHealth).not.toHaveBeenCalled();
  });

  it('defaults the offset to zero and passes the signed-in user', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(state.getDiscoveryHealth).toHaveBeenCalledWith('source-health-user', 0);
  });

  it('accepts a bounded integer offset', async () => {
    expect((await GET(request('?offset=100000'))).status).toBe(200);
    expect(state.getDiscoveryHealth).toHaveBeenCalledWith('source-health-user', 100000);
  });

  it.each(['-1', '1.5', '100001', '1e2', ' 2', '01'])('rejects invalid offset %s', async offset => {
    expect((await GET(request(`?offset=${encodeURIComponent(offset)}`))).status).toBe(400);
  });
});
