import 'server-only';
import { createApiHandler } from '@career-workspace/core';
import { getCurrentUser } from './current-user';
import { isClerkConfigured } from './clerk-config';
import { clerkClient } from '@clerk/nextjs/server';
import { ClerkIdentityMissingError, ensureUserForClerkId } from './user-record';

export const extensionOrigin =
  'chrome-extension://efpojcicpmejmpjeeaekchonofonmbkm';
const localOrigins = ['http://localhost:3000', 'http://localhost:3001'];

function configuredAppOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return undefined;
    if (url.protocol === 'https:') return url.origin;
    if (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      return url.origin;
  } catch {
    return undefined;
  }
  return undefined;
}

export function getTrustedParties(appUrl = process.env.APP_URL): string[] {
  return [
    ...new Set(
      [extensionOrigin, ...localOrigins, configuredAppOrigin(appUrl)].filter(
        (origin): origin is string => Boolean(origin),
      ),
    ),
  ];
}

const trustedParties = getTrustedParties();

async function localUser(userId: string) {
  try {
    return await ensureUserForClerkId(userId);
  } catch (error) {
    if (error instanceof ClerkIdentityMissingError) return null;
    throw error;
  }
}

export const authenticateApi = async (request?: Request) => {
  if (!isClerkConfigured()) return null;
  const authorization = request?.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return getCurrentUser();

  if (!request) return null;
  const origin = request.headers.get('origin');
  if (origin && !trustedParties.includes(origin)) return null;
  const clerk = await clerkClient();
  const state = await clerk.authenticateRequest(request, {
    authorizedParties: trustedParties,
  });
  if (!state.isAuthenticated) return null;
  const { userId } = state.toAuth();
  return userId ? localUser(userId) : null;
};

/** Shared guards for routes that need streaming or binary responses. */
export function manualRouteAccessError(
  user: Awaited<ReturnType<typeof authenticateApi>>,
): Response | null {
  if (!user)
    return Response.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  if (user.deletionRequestedAt)
    return Response.json(
      {
        error: {
          code: 'ACCOUNT_DELETION_PENDING',
          message:
            'Account deletion is in progress. Use the deletion status page to retry.',
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  return null;
}

/** Log only an allowlisted error code and opaque request ID; never log the error object. */
export function logApiFailure(request: Request, code: string): string {
  const allowedCodes = new Set([
    'INTERNAL_ERROR',
    'COACH_UNAVAILABLE',
    'WORKFLOW_START_FAILED',
    'STORAGE_READ_FAILED',
  ]);
  const safeCode = allowedCodes.has(code) ? code : 'INTERNAL_ERROR';
  const incoming = request.headers.get('x-request-id');
  const requestId =
    incoming &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      incoming,
    )
      ? incoming
      : crypto.randomUUID();
  const category =
    safeCode === 'COACH_UNAVAILABLE'
      ? 'AI_PROVIDER'
      : safeCode === 'WORKFLOW_START_FAILED'
        ? 'WORKFLOW'
        : safeCode === 'STORAGE_READ_FAILED'
          ? 'STORAGE'
          : 'UNKNOWN';
  console.error(
    JSON.stringify({
      event: 'api_failure',
      source: 'manual_route',
      code: safeCode,
      category,
      requestId,
    }),
  );
  return requestId;
}

export function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function withApiCors(response: Response, request: Request): Response {
  const origin = request.headers.get('origin');
  if (!origin || !trustedParties.includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function apiOptions(request: Request): Response {
  const origin = request.headers.get('origin');
  if (!origin || !trustedParties.includes(origin))
    return new Response(null, { status: 403 });
  const requestedMethod = request.headers.get('access-control-request-method');
  if (
    requestedMethod &&
    !['GET', 'PATCH', 'POST', 'OPTIONS'].includes(requestedMethod)
  ) {
    return new Response(null, { status: 405 });
  }
  const requestedHeaders =
    request.headers.get('access-control-request-headers') ?? '';
  const headers = requestedHeaders
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (
    headers.some(
      (header) =>
        !['authorization', 'content-type', 'idempotency-key'].includes(header),
    )
  ) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PATCH, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, Idempotency-Key',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  });
}

export { createApiHandler };
