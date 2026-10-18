import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  authenticateRequest,
  ensureUserForClerkId,
  getCurrentUser,
  isClerkConfigured,
} = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  ensureUserForClerkId: vi.fn(),
  getCurrentUser: vi.fn(),
  isClerkConfigured: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({ authenticateRequest }),
}));
vi.mock('server-only', () => ({}));
vi.mock('./current-user', () => ({ getCurrentUser }));
vi.mock('./clerk-config', () => ({ isClerkConfigured }));
vi.mock('./user-record', () => ({
  ClerkIdentityMissingError: class ClerkIdentityMissingError extends Error {},
  ensureUserForClerkId,
}));

import {
  apiOptions,
  authenticateApi,
  extensionOrigin,
  getTrustedParties,
  logApiFailure,
  manualRouteAccessError,
  withRequestId,
} from './api-route';

describe('API bearer authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isClerkConfigured.mockReturnValue(true);
    authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({ userId: 'clerk-user-123' }),
    });
    ensureUserForClerkId.mockResolvedValue({ id: 'local-user-123' });
    getCurrentUser.mockResolvedValue({ id: 'cookie-user-123' });
  });

  it('authenticates a signed bearer token from the extension when the browser omits Origin', async () => {
    const request = new Request('http://localhost:3001/api/v1/me', {
      headers: { authorization: 'Bearer signed-token' },
    });

    await expect(authenticateApi(request)).resolves.toEqual({
      id: 'local-user-123',
    });
    expect(authenticateRequest).toHaveBeenCalledWith(request, {
      authorizedParties: [
        extensionOrigin,
        'http://localhost:3000',
        'http://localhost:3001',
      ],
    });
    expect(ensureUserForClerkId).toHaveBeenCalledWith('clerk-user-123');
  });

  it('rejects an explicit untrusted Origin before asking Clerk to validate the token', async () => {
    const request = new Request('http://localhost:3001/api/v1/me', {
      headers: {
        authorization: 'Bearer signed-token',
        origin: 'https://untrusted.example',
      },
    });

    await expect(authenticateApi(request)).resolves.toBeNull();
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(ensureUserForClerkId).not.toHaveBeenCalled();
  });

  it('does not trust a missing-Origin bearer token unless Clerk authenticates it', async () => {
    authenticateRequest.mockResolvedValueOnce({
      isAuthenticated: false,
      reason: 'token-invalid',
      toAuth: () => ({ userId: null }),
    });
    const request = new Request('http://localhost:3001/api/v1/me', {
      headers: { authorization: 'Bearer invalid-token' },
    });

    await expect(authenticateApi(request)).resolves.toBeNull();
    expect(authenticateRequest).toHaveBeenCalledWith(request, {
      authorizedParties: [
        extensionOrigin,
        'http://localhost:3000',
        'http://localhost:3001',
      ],
    });
    expect(ensureUserForClerkId).not.toHaveBeenCalled();
  });

  it('uses Clerk validation for trusted origins and falls back to cookie auth without a bearer', async () => {
    const request = new Request('http://localhost:3001/api/v1/me', {
      headers: {
        authorization: 'Bearer signed-token',
        origin: extensionOrigin,
      },
    });
    await expect(authenticateApi(request)).resolves.toEqual({
      id: 'local-user-123',
    });

    await expect(
      authenticateApi(new Request('http://localhost:3001/api/v1/me')),
    ).resolves.toEqual({ id: 'cookie-user-123' });
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('requires an allowed Origin for CORS preflight', () => {
    expect(
      apiOptions(
        new Request('http://localhost:3001/api/v1/me', { method: 'OPTIONS' }),
      ).status,
    ).toBe(403);
    const response = apiOptions(
      new Request('http://localhost:3001/api/v1/me', {
        method: 'OPTIONS',
        headers: {
          origin: extensionOrigin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      extensionOrigin,
    );
  });

  it('adds only a valid configured HTTPS app origin to the Clerk allowlist', () => {
    expect(getTrustedParties('https://career.example.com/')).toContain(
      'https://career.example.com',
    );
    expect(getTrustedParties('http://localhost:3002')).toContain(
      'http://localhost:3002',
    );
    expect(getTrustedParties('https://career.example.com/path')).not.toContain(
      'https://career.example.com',
    );
    expect(getTrustedParties('http://career.example.com')).not.toContain(
      'http://career.example.com',
    );
    expect(
      getTrustedParties('https://user:password@career.example.com'),
    ).not.toContain('https://career.example.com');
    expect(
      getTrustedParties('https://career.example.com.evil.test'),
    ).not.toContain('https://career.example.com');
    expect(getTrustedParties('https://career.example.com')).toContain(
      extensionOrigin,
    );
  });
});

describe('manual route access guards and safe logs', () => {
  it('allows accounts without age confirmation while enforcing account deletion', async () => {
    const userBase = {
      id: 'u',
      clerkId: 'clerk-u',
      role: 'candidate',
      coachId: 'coach',
      targetRoles: [],
      preferredLocation: '',
      workPreference: 'any',
      paperSize: 'A4',
      cvName: '',
      cvContact: '',
      firstFitReviewUsed: false,
      firstFitReviewRequestKey: null,
      firstFitReviewOpportunityId: null,
      ageConfirmedAt: null,
      deletionRequestedAt: null,
      createdAt: new Date(),
    };
    await expect(manualRouteAccessError(null)!.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    });
    expect(manualRouteAccessError(userBase)).toBeNull();
    const response = manualRouteAccessError({
      ...userBase,
      ageConfirmedAt: new Date(),
      deletionRequestedAt: new Date(),
    });
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({
      error: { code: 'ACCOUNT_DELETION_PENDING' },
    });
  });

  it('logs only an allowlisted code and opaque request identifier', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requestId = logApiFailure(
      new Request('http://localhost', {
        headers: { 'x-request-id': '550e8400-e29b-41d4-a716-446655440000' },
      }),
      'COACH_UNAVAILABLE',
    );
    expect(requestId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(log.mock.calls[0][0]).toBe(
      JSON.stringify({
        event: 'api_failure',
        source: 'manual_route',
        code: 'COACH_UNAVAILABLE',
        category: 'AI_PROVIDER',
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      }),
    );
    const response = withRequestId(
      Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 }),
      requestId,
    );
    expect(response.headers.get('x-request-id')).toBe(requestId);
    expect(response.headers.get('content-type')).toContain('application/json');
    logApiFailure(new Request('http://localhost'), 'STORAGE_READ_FAILED');
    expect(JSON.parse(log.mock.calls[1][0] as string)).toMatchObject({
      code: 'STORAGE_READ_FAILED',
      category: 'STORAGE',
    });
    log.mockRestore();
  });
});
