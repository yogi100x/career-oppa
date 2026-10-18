import { describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';
import { DiscoverySourceFetchError } from './job-discovery';
import { fetchDiscoveryCompanyDataset, parseDiscoveryCompanyDataset } from './discovery-dataset';

const publicAddress = [{ address: '93.184.216.34', family: 4 }];
const response = (value: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Response(JSON.stringify(value), { status, headers });

describe('discovery company dataset', () => {
  it('normalizes, validates, and deduplicates provider slugs', () => {
    expect(parseDiscoveryCompanyDataset('greenhouse', ['figma', 'figma', 'quantco-', '../bad', 'UPPER', 'bad.slug', 'has space', ' figma ', 7])).toEqual({
      sources: [
        { id: 'greenhouse:figma', provider: 'greenhouse', board: 'figma', company: 'Figma' },
        { id: 'greenhouse:quantco-', provider: 'greenhouse', board: 'quantco-', company: 'Quantco' },
      ], rejected: 6,
    });
    expect(() => parseDiscoveryCompanyDataset('ashby', { companies: ['notion'] })).toThrow('invalid format');
    expect(() => parseDiscoveryCompanyDataset('ashby', ['../bad'])).toThrow('no valid boards');
  });

  it('fetches only the fixed raw GitHub file with a pinned public address', async () => {
    const transport = vi.fn(async (_url: URL) => response(['sample-company']));
    const result = await fetchDiscoveryCompanyDataset('lever', { resolver: async () => publicAddress, transport });
    expect(result).toMatchObject({ sources: [expect.objectContaining({ id: 'lever:sample-company', board: 'sample-company' })], rejected: 0 });
    expect(transport.mock.calls[0]![0].toString()).toBe('https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/lever_companies.json');
  });

  it('accepts raw GitHub text/plain JSON but rejects HTML and non-JSON text', async () => {
    const options = { resolver: async () => publicAddress };
    await expect(fetchDiscoveryCompanyDataset('lever', { ...options, transport: async () => response(['example'], 200, { 'content-type': 'text/plain; charset=utf-8' }) }))
      .resolves.toMatchObject({ sources: [expect.objectContaining({ board: 'example' })] });
    await expect(fetchDiscoveryCompanyDataset('lever', { ...options, transport: async () => response(['example'], 200, { 'content-type': 'text/html' }) }))
      .rejects.toThrow('invalid response');
    await expect(fetchDiscoveryCompanyDataset('lever', { ...options, transport: async () => new Response('not JSON', { headers: { 'content-type': 'text/plain' } }) }))
      .rejects.toThrow('invalid JSON');
  });

  it.each([
    [404, 'not-found'], [410, 'not-found'], [403, 'refused'], [429, 'refused'], [503, 'transient'],
  ] as const)('classifies HTTP %s as %s', async (status, kind) => {
    const headers = { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '12' } : {}) };
    await expect(fetchDiscoveryCompanyDataset('ashby', {
      resolver: async () => publicAddress, transport: async () => response({}, status, headers),
    })).rejects.toMatchObject({ kind, status, ...(status === 429 ? { retryAfterMs: 12_000 } : {}) });
  });

  it('rejects private DNS answers, redirects, malformed data, and an unbounded resolver', async () => {
    await expect(fetchDiscoveryCompanyDataset('greenhouse', { resolver: async () => [{ address: '127.0.0.1', family: 4 }], transport: vi.fn() }))
      .rejects.toThrow('address is not public');
    await expect(fetchDiscoveryCompanyDataset('greenhouse', { resolver: async () => publicAddress, transport: async () => response({}, 302) }))
      .rejects.toBeInstanceOf(DiscoverySourceFetchError);
    await expect(fetchDiscoveryCompanyDataset('greenhouse', { resolver: async () => publicAddress, transport: async () => new Response('nope', { headers: { 'content-type': 'application/json' } }) }))
      .rejects.toThrow('invalid JSON');
    const transport = vi.fn();
    await expect(fetchDiscoveryCompanyDataset('greenhouse', { timeoutMs: 5, resolver: async () => new Promise(() => {}), transport }))
      .rejects.toThrow('address lookup failed');
    expect(transport).not.toHaveBeenCalled();
  });
});
