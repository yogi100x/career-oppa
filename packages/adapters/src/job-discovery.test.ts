import { describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';
import { DISCOVERY_SOURCES, fetchDiscoveryBoard, type DiscoverySource } from './job-discovery';

const publicAddress = [{ address: '93.184.216.34', family: 4 }];
const jsonResponse = (value: unknown, status = 200, contentType = 'application/json') =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': contentType } });
const source = (id: string) => DISCOVERY_SOURCES.find(item => item.id === id)!;
const options = (payload: unknown, status = 200) => ({
  resolver: async () => publicAddress,
  transport: vi.fn(async () => jsonResponse(payload, status)),
});

describe('fetchDiscoveryBoard', () => {
  it('retains the six legacy seed boards while datasets provide the wider catalog', () => {
    const ids = DISCOVERY_SOURCES.map(item => item.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(DISCOVERY_SOURCES.map(item => item.provider))).toEqual(new Set(['greenhouse', 'lever', 'ashby']));
    expect(ids).toEqual(expect.arrayContaining([
      'greenhouse:figma', 'greenhouse:gitlab', 'lever:palantir', 'lever:spotify', 'ashby:notion', 'ashby:linear',
    ]));
  });

  it('normalizes Greenhouse text and decodes escaped HTML', async () => {
    const response = await fetchDiscoveryBoard(source('greenhouse:figma'), options({ jobs: [
      { id: 7, title: ' Designer ', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/figma/jobs/7', content: '&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;', updated_at: '2026-01-02T03:04:05Z' },
    ] }));
    expect(response).toEqual([expect.objectContaining({
      provider: 'greenhouse', externalId: '7', title: 'Designer', company: 'Figma', location: 'Remote',
      workMode: 'remote', text: 'Build & ship', postedAt: null,
    })]);
  });

  it('normalizes Lever array payloads and multi-location fields', async () => {
    const response = await fetchDiscoveryBoard(source('lever:spotify'), options([
      { id: 'req-1', text: 'Engineer', hostedUrl: 'https://jobs.lever.co/spotify/req-1', categories: { location: 'London', allLocations: ['Remote'] }, descriptionPlain: 'Role details', createdAt: 1 },
    ]));
    expect(response[0]).toMatchObject({ externalId: 'req-1', title: 'Engineer', location: 'London · Remote', workMode: 'remote', text: 'Role details', postedAt: '1970-01-01T00:00:00.001Z' });
  });

  it('normalizes Ashby workplace data', async () => {
    const response = await fetchDiscoveryBoard(source('ashby:notion'), options({ jobs: [
      { id: 'n-1', title: 'Product Designer', location: 'New York', workplaceType: 'Hybrid', jobUrl: 'https://jobs.ashbyhq.com/notion/n-1', descriptionPlain: 'Plan and design', publishedAt: '2026-02-01' },
    ] }));
    expect(response[0]).toMatchObject({ location: 'New York', workMode: 'hybrid', text: 'Plan and design' });
  });

  it('skips Ashby records explicitly marked unlisted and rejects malformed listed rows', async () => {
    const unlisted = await fetchDiscoveryBoard(source('ashby:notion'), options({ jobs: [
      { isListed: false },
      { id: 'n-2', title: 'Designer', location: 'Remote', jobUrl: 'https://jobs.ashbyhq.com/notion/n-2', descriptionPlain: 'Design work' },
    ] }));
    expect(unlisted).toHaveLength(1);
    await expect(fetchDiscoveryBoard(source('greenhouse:figma'), options({ jobs: [
      { id: 'good', title: 'Engineer', absolute_url: 'https://job-boards.greenhouse.io/figma/jobs/good', content: 'Valid' },
      { id: 'broken', title: '', absolute_url: 'https://job-boards.greenhouse.io/figma/jobs/broken', content: 'Missing title' },
    ] }))).rejects.toThrow('incomplete board');
  });

  it('rejects arbitrary sources, unsafe resolved addresses, redirects, and incomplete payloads', async () => {
    await expect(fetchDiscoveryBoard({ id: 'lever:../evil', provider: 'lever', board: '../evil', company: 'Evil' } as DiscoverySource)).rejects.toThrow('invalid');
    await expect(fetchDiscoveryBoard(source('greenhouse:figma'), { resolver: async () => [{ address: '127.0.0.1', family: 4 }], transport: vi.fn() })).rejects.toThrow('not public');
    await expect(fetchDiscoveryBoard(source('greenhouse:figma'), { ...options({}), transport: vi.fn(async () => jsonResponse({}, 302)) })).rejects.toThrow('redirected');
    await expect(fetchDiscoveryBoard(source('greenhouse:figma'), options({}))).rejects.toThrow('incomplete board');
  });

  it('accepts a validated dataset slug outside the seed list', async () => {
    const transport = vi.fn(async (_url: URL) => jsonResponse({ jobs: [] }));
    await expect(fetchDiscoveryBoard({ id: 'greenhouse:quantco-', provider: 'greenhouse', board: 'quantco-', company: 'Quantco' }, {
      resolver: async () => publicAddress, transport,
    })).resolves.toEqual([]);
    expect(new URL(transport.mock.calls[0]![0].toString()).pathname).toContain('/boards/quantco-/jobs');
  });

  it('bounds a stalled DNS lookup with the board timeout', async () => {
    const transport = vi.fn();
    await expect(fetchDiscoveryBoard(source('greenhouse:figma'), {
      timeoutMs: 5,
      resolver: async () => new Promise(() => {}),
      transport,
    })).rejects.toThrow('could not be reached');
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects oversized or over-limit boards so they cannot be treated as complete', async () => {
    const manyRows = Array.from({ length: 2001 }, (_, i) => ({ id: i, title: 'Role', absolute_url: `https://job-boards.greenhouse.io/figma/jobs/${i}` }));
    await expect(fetchDiscoveryBoard(source('greenhouse:figma'), options({ jobs: manyRows }))).rejects.toThrow('complete scan limit');
    const huge = 'x'.repeat(8 * 1024 * 1024 + 1);
    const response = new Response(huge, { headers: { 'content-type': 'application/json' } });
    await expect(fetchDiscoveryBoard(source('greenhouse:figma'), { resolver: async () => publicAddress, transport: vi.fn(async () => response) })).rejects.toThrow('too large');
  });
});
