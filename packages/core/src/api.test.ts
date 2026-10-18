import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiHandler } from './api';

const user = { id: 'candidate', role: 'candidate', ageConfirmedAt: null };
const schema = {
  safeParse: (input: unknown) =>
    input === 'valid'
      ? { success: true as const, data: input }
      : { success: false as const, error: 'invalid' },
};
describe('authenticated route checks', () => {
  afterEach(() => vi.restoreAllMocks());
  it('refuses signed-out requests before calling the handler', async () => {
    const route = createApiHandler({
      authenticate: async () => null,
      handler: async () => {
        throw new Error('Must not run');
      },
    });
    expect(
      (await route(new Request('http://localhost/api/v1/me'))).status,
    ).toBe(401);
  });
  it('allows signed-in users without age confirmation', async () => {
    const route = createApiHandler({
      authenticate: async () => user,
      handler: async () => 'private',
    });
    const response = await route(
      new Request('http://localhost/api/v1/private'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: 'private' });
  });
  it('allows the me route for any signed-in user', async () => {
    const route = createApiHandler({
      authenticate: async () => user,
      handler: async () => user.id,
    });
    expect(
      await (await route(new Request('http://localhost/api/v1/me'))).json(),
    ).toEqual({ data: 'candidate' });
  });
  it('rejects invalid input', async () => {
    const route = createApiHandler({
      authenticate: async () => ({ ...user, ageConfirmedAt: new Date() }),
      schema,
      handler: async () => 'saved',
    });
    expect(
      (
        await route(
          new Request('http://localhost/api/v1/private', {
            method: 'POST',
            body: JSON.stringify('invalid'),
          }),
        )
      ).status,
    ).toBe(400);
  });
  it('rejects a candidate on an admin route', async () => {
    const route = createApiHandler({
      authenticate: async () => ({ ...user, ageConfirmedAt: new Date() }),
      admin: true,
      handler: async () => 'admin',
    });
    expect(
      (await route(new Request('http://localhost/api/v1/admin'))).status,
    ).toBe(403);
  });
  it('does not expose private error details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const route = createApiHandler({
      authenticate: async () => user,
      handler: async () => {
        throw new Error('private candidate text');
      },
    });
    const response = await route(new Request('http://localhost/api/v1/me'));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(
      'private candidate text',
    );
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(
      /"code":"INTERNAL_ERROR","category":"UNKNOWN"/,
    );
    expect(log.mock.calls[0][0]).not.toContain('private candidate text');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
  });
  it('logs only an allowlisted category for database failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const route = createApiHandler({
      authenticate: async () => user,
      handler: async () => {
        throw Object.assign(new Error('private SQL and candidate data'), {
          code: '42P01',
        });
      },
    });
    const response = await route(
      new Request('http://localhost/api/v1/me', {
        headers: { 'x-request-id': '550e8400-e29b-41d4-a716-446655440000' },
      }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(log.mock.calls[0][0]).toBe(
      JSON.stringify({
        event: 'api_failure',
        source: 'create_api_handler',
        code: 'INTERNAL_ERROR',
        category: 'DATABASE_SCHEMA',
        requestId: '550e8400-e29b-41d4-a716-446655440000',
      }),
    );
    expect(log.mock.calls[0][0]).not.toContain('private SQL');
  });
  it('keeps the deletion-status exception while blocking other routes, including admin routes', async () => {
    const deletingUser = {
      id: 'candidate',
      role: 'admin',
      ageConfirmedAt: new Date(),
      deletionRequestedAt: new Date(),
    };
    const privateRoute = createApiHandler({
      authenticate: async () => deletingUser,
      handler: async () => 'private',
    });
    expect(
      (await privateRoute(new Request('http://localhost/api/v1/private')))
        .status,
    ).toBe(403);
    const statusRoute = createApiHandler({
      authenticate: async () => deletingUser,
      allowDeletionPending: true,
      handler: async () => 'status',
    });
    expect(
      await (
        await statusRoute(new Request('http://localhost/api/v1/deletion'))
      ).json(),
    ).toEqual({ data: 'status' });
    const adminRoute = createApiHandler({
      authenticate: async () => deletingUser,
      admin: true,
      handler: async () => 'admin',
    });
    expect(
      (await adminRoute(new Request('http://localhost/api/v1/admin'))).status,
    ).toBe(403);
  });
});
