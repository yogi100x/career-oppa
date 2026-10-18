import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  discoveryCollectionState,
  discoverySweeps,
  publicJobDiscoveryJobs,
  publicJobDiscoverySources,
} from '@career-workspace/db';
import { eq } from 'drizzle-orm';
import type { DiscoveryProvider } from '@career-workspace/adapters/job-discovery';
import type { DiscoveryCompanyDataset } from '@career-workspace/adapters/discovery-dataset';
import { advanceDiscoverySweep, prepareScheduledDiscovery } from './discovery-sweep';
import { discoveryJobSightings } from '@career-workspace/db';
import { DISCOVERY_PROVIDERS } from './discovery-policy';

const connectionString = process.env.DATABASE_TEST_URL;
describe.skipIf(!connectionString)('scheduled discovery sweep checkpoints', () => {
  const { database, pool } = createDatabase(connectionString!);

  function assertTestDatabase() {
    if (new URL(connectionString!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
  }

  function dataset(count: number) {
    return vi.fn(async (provider: DiscoveryProvider): Promise<DiscoveryCompanyDataset> => ({
      sources: Array.from({ length: count }, (_, index) => ({
        id: `${provider}:sweep-${index.toString().padStart(3, '0')}`,
        provider,
        board: `sweep-${index.toString().padStart(3, '0')}`,
        company: `Company ${index}`,
      })),
      rejected: 0,
    }));
  }

  beforeEach(async () => {
    assertTestDatabase();
    await database.delete(publicJobDiscoveryJobs);
    await database.delete(discoveryJobSightings);
    await database.delete(discoverySweeps);
    await database.delete(publicJobDiscoverySources);
    await database.delete(discoveryCollectionState);
  });

  afterAll(async () => {
    assertTestDatabase();
    await pool.end();
  });

  it('spreads a directory larger than 180 boards over bounded checkpoints', async () => {
    const fetchDataset = dataset(70);
    const key = await prepareScheduledDiscovery(`large-${randomUUID()}`, { database, fetchDataset });
    const collect = vi.fn(async ({ sourceIds = [] }: { sourceIds?: string[] } = {}) => ({
      refreshed: sourceIds.length,
      failed: 0,
      skipped: 0,
      halted: false,
    }));

    const first = await advanceDiscoverySweep(key, { database, collect, clock: () => 0 });
    expect(first).toMatchObject({ done: false, processed: 180, total: 210, refreshed: 180 });
    expect(collect.mock.calls.reduce((sum, [options]) => sum + (options?.sourceIds?.length ?? 0), 0)).toBe(180);

    const second = await advanceDiscoverySweep(key, { database, collect, clock: () => 0 });
    expect(second).toMatchObject({ done: true, processed: 210, total: 210, refreshed: 210 });
  });

  it('yields on the time budget and resumes the saved sweep key on the next daily trigger', async () => {
    const fetchDataset = dataset(20);
    const key = await prepareScheduledDiscovery(`budget-${randomUUID()}`, { database, fetchDataset });
    let clockCalls = 0;
    const collect = vi.fn(async ({ sourceIds = [] }: { sourceIds?: string[] } = {}) => ({
      refreshed: sourceIds.length,
      failed: 0,
      skipped: 0,
      halted: false,
    }));
    const first = await advanceDiscoverySweep(key, {
      database,
      collect,
      budgetMs: 40_000,
      clock: () => (clockCalls++ === 0 ? 0 : 21_000),
    });
    expect(first).toMatchObject({ done: false, processed: 18, total: 60 });
    await expect(prepareScheduledDiscovery(`next-day-${randomUUID()}`, { database, fetchDataset })).resolves.toBe(key);
    expect(fetchDataset).toHaveBeenCalledTimes(DISCOVERY_PROVIDERS.length);

    const second = await advanceDiscoverySweep(key, { database, collect, clock: () => 0 });
    expect(second).toMatchObject({ done: true, processed: 60, total: 60 });
  });

  it('persists the cursor and releases its lease when a collection wave throws', async () => {
    const key = await prepareScheduledDiscovery(`retry-${randomUUID()}`, { database, fetchDataset: dataset(12) });
    let calls = 0;
    const seen: string[][] = [];
    const collect = vi.fn(async ({ sourceIds = [] }: { sourceIds?: string[] } = {}) => {
      seen.push(sourceIds);
      calls++;
      return calls === 1
        ? { refreshed: 0, failed: sourceIds.length, skipped: 0, halted: false }
        : calls === 2
          ? Promise.reject(new Error('recorded workflow step failure'))
        : { refreshed: sourceIds.length, failed: 0, skipped: 0, halted: false };
    });
    let clockCalls = 0;
    const yielded = await advanceDiscoverySweep(key, {
      database,
      collect,
      budgetMs: 40_000,
      clock: () => (clockCalls++ === 0 ? 0 : 21_000),
    });
    expect(yielded).toMatchObject({ done: false, processed: 18, failed: 18, refreshed: 0 });
    const [saved] = await database.select().from(discoverySweeps).where(eq(discoverySweeps.key, key));
    expect(saved).toMatchObject({ nextIndex: 18, failed: 18, refreshed: 0, leaseToken: null, leaseUntil: null });

    await expect(advanceDiscoverySweep(key, { database, collect, clock: () => 0 })).rejects.toThrow('recorded workflow step failure');
    const [afterFailure] = await database.select().from(discoverySweeps).where(eq(discoverySweeps.key, key));
    expect(afterFailure).toMatchObject({ nextIndex: 18, failed: 18, refreshed: 0, leaseToken: null, leaseUntil: null });

    const resumed = await advanceDiscoverySweep(key, { database, collect, clock: () => 0 });
    expect(resumed).toMatchObject({ done: true, processed: 36, failed: 18, refreshed: 18 });
    expect(seen[1]).toEqual(saved.sourceIds.slice(18, 36));
    expect(seen[2]).toEqual(saved.sourceIds.slice(18, 36));
  });

  it('returns busy without marking the sweep done while another lease is live', async () => {
    const key = await prepareScheduledDiscovery(`busy-${randomUUID()}`, { database, fetchDataset: dataset(2) });
    await database.update(discoverySweeps).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) }).where(eq(discoverySweeps.key, key));
    const collect = vi.fn();
    const result = await advanceDiscoverySweep(key, { database, collect });
    expect(result).toMatchObject({ done: false, busy: true, processed: 0, total: 6 });
    expect(collect).not.toHaveBeenCalled();
  });
});
