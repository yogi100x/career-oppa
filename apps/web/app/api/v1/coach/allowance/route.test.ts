import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const state = vi.hoisted(() => ({
  userId: 'allowance-user' as string | null,
  deletionRequestedAt: null as Date | null,
  getCoachAllowance: vi.fn(),
}));

vi.mock('../../../../../lib/api-route', async () => {
  const { createApiHandler } = await import('@career-workspace/core');
  return {
    createApiHandler,
    authenticateApi: async () => state.userId
      ? {
          id: state.userId,
          role: 'candidate',
          ageConfirmedAt: null,
          deletionRequestedAt: state.deletionRequestedAt,
        }
      : null,
  };
});
vi.mock('@career-workspace/core/coach', () => ({
  getCoachAllowance: state.getCoachAllowance,
}));

beforeEach(() => {
  state.userId = 'allowance-user';
  state.deletionRequestedAt = null;
  state.getCoachAllowance.mockReset().mockResolvedValue({
    limit: 20,
    used: 15,
    pending: 0,
    remaining: 5,
    resetAt: new Date('2030-05-06T10:00:00.000Z'),
  });
});

describe('coach allowance endpoint', () => {
  it('requires sign-in', async () => {
    state.userId = null;
    expect((await GET(new Request('http://localhost:3000/api/v1/coach/allowance'))).status).toBe(401);
    expect(state.getCoachAllowance).not.toHaveBeenCalled();
  });

  it('returns only the signed-in user’s allowance', async () => {
    const response = await GET(new Request('http://localhost:3000/api/v1/coach/allowance'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { limit: 20, used: 15, pending: 0, remaining: 5 },
    });
    expect(state.getCoachAllowance).toHaveBeenCalledExactlyOnceWith('allowance-user');
  });

  it('blocks accounts with deletion in progress', async () => {
    state.deletionRequestedAt = new Date();
    expect((await GET(new Request('http://localhost:3000/api/v1/coach/allowance'))).status).toBe(403);
    expect(state.getCoachAllowance).not.toHaveBeenCalled();
  });
});
