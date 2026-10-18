import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const state = vi.hoisted(() => ({
  signedIn: true,
  ageConfirmed: true,
  allowed: true,
}));
vi.mock('../../../../../lib/api-route', async () => {
  const { createApiHandler } = await import('@career-workspace/core');
  return {
    createApiHandler,
    authenticateApi: async () =>
      state.signedIn
        ? {
            id: 'test-buyer',
            role: 'candidate',
            ageConfirmedAt: state.ageConfirmed ? new Date() : null,
          }
        : null,
  };
});
vi.mock('@career-workspace/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkRateLimit: async () => ({ allowed: state.allowed }),
}));

function request(
  body: unknown = { packId: 'starter' },
  key = 'checkout-test-key',
) {
  return new Request('http://localhost:3000/api/v1/credits/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.signedIn = true;
  state.ageConfirmed = true;
  state.allowed = true;
  vi.stubEnv('DODO_PAYMENTS_API_KEY', 'REPLACE_WITH_TEST_KEY');
});
afterEach(() => vi.unstubAllEnvs());

describe('credit checkout route', () => {
  it('requires sign-in without requiring age confirmation', async () => {
    state.signedIn = false;
    expect((await POST(request())).status).toBe(401);
    state.signedIn = true;
    state.ageConfirmed = false;
    expect((await POST(request())).status).toBe(503);
  });
  it('refuses client-defined price or credit count', async () => {
    expect(
      (await POST(request({ packId: 'starter', credits: 999999, price: 1 })))
        .status,
    ).toBe(400);
    expect((await POST(request({ packId: 'unknown' }))).status).toBe(400);
  });
  it('requires a bounded request key', async () => {
    expect((await POST(request({ packId: 'starter' }, ''))).status).toBe(400);
    expect(
      (await POST(request({ packId: 'starter' }, 'x'.repeat(101)))).status,
    ).toBe(400);
  });
  it('explains missing setup without pretending a purchase happened', async () => {
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'PAYMENTS_NOT_CONFIGURED',
        message: expect.stringContaining('balance has not changed'),
      },
    });
  });
  it('limits repeated attempts', async () => {
    state.allowed = false;
    expect((await POST(request())).status).toBe(429);
  });
});
