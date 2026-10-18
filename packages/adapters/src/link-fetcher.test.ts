import { describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';
import { fetchJobPage, isPublicAddress, resolvePublicUrl } from './link-fetcher';

describe('safe role page fetching', () => {
  it('blocks internal, metadata, local and mapped addresses', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
      expect(isPublicAddress(address)).toBe(false);
      await expect(resolvePublicUrl('https://jobs.example', async () => [{ address, family: address.includes(':') ? 6 : 4 }])).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    }
  });
  it('rejects unsafe schemes, ports, credentials, and mixed DNS answers', async () => {
    for (const url of ['file:///etc/passwd', 'http://localhost:8080', 'https://user:password@jobs.example', 'http://2130706433']) await expect(resolvePublicUrl(url)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    await expect(resolvePublicUrl('https://jobs.example', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });
  it('rechecks a redirect and never fetches its private destination', async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const transport = vi.fn(async () => ({ response: new Response(null, { status: 302, headers: { location: 'https://internal.example/job' } }), close: async () => {} }));
    await expect(fetchJobPage('https://jobs.example/role', { resolve, transport })).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it('passes the checked IP to transport without looking up DNS again', async () => {
    const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const transport = vi.fn(async (_url: URL, _address: { address: string; family: number }, _signal: AbortSignal) => ({ response: new Response('Role description', { headers: { 'content-type': 'text/html' } }), close: async () => {} }));
    expect((await fetchJobPage('https://jobs.example/role', { resolve, transport })).text).toBe('Role description');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]).toEqual({ address: '8.8.8.8', family: 4 });
  });
  it('limits body size and redirects', async () => {
    const resolve = async () => [{ address: '8.8.8.8', family: 4 }];
    await expect(fetchJobPage('https://jobs.example', { resolve, transport: async () => ({ response: new Response('x'.repeat(2 * 1024 * 1024 + 1)), close: async () => {} }) })).rejects.toMatchObject({ code: 'NEEDS_PASTE' });
    const transport = vi.fn(async () => ({ response: new Response(null, { status: 302, headers: { location: '/another' } }), close: async () => {} }));
    await expect(fetchJobPage('https://jobs.example', { resolve, transport })).rejects.toMatchObject({ code: 'NEEDS_PASTE' });
    expect(transport).toHaveBeenCalledTimes(4);
  });
});
