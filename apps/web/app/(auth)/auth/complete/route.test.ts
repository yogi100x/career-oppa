import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userId: 'user_123' as string | null }));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: state.userId })),
}));

import { NextRequest } from 'next/server';
import { GET } from './route';

describe('/auth/complete', () => {
  beforeEach(() => {
    state.userId = 'user_123';
  });

  it('sends authenticated users directly to the default workspace', async () => {
    const response = await GET(
      new NextRequest('http://localhost/auth/complete'),
    );

    expect(response.headers.get('location')).toBe('http://localhost/workspace');
  });

  it('returns authenticated users to a safe workspace role path', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/auth/complete?next=%2Fworkspace%2Froles%2Frole_123%3Ftab%3Dresume',
      ),
    );

    expect(response.headers.get('location')).toBe(
      'http://localhost/workspace/roles/role_123?tab=resume',
    );
  });

  it('rejects an external completion destination', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/auth/complete?next=https%3A%2F%2Fattacker.example%2Fworkspace',
      ),
    );

    expect(response.headers.get('location')).toBe('http://localhost/workspace');
  });

  it('sends visitors to sign-in and preserves their safe workspace destination', async () => {
    state.userId = null;
    const response = await GET(
      new NextRequest(
        'http://localhost/auth/complete?next=%2Fworkspace%2Froles%2Frole_123',
      ),
    );

    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('redirect_url')).toBe(
      '/workspace/roles/role_123',
    );
  });
});
