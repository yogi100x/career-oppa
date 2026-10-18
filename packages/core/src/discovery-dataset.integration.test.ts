import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  discoveryCollectionState,
  discoveryJobSightings,
  discoverySweeps,
  publicJobDiscoveryJobs,
  publicJobDiscoverySources,
  users,
} from '@career-workspace/db';
import { eq } from 'drizzle-orm';
import {
  DiscoverySourceFetchError,
  type DiscoveryProvider,
  type DiscoverySource,
  type PublicDiscoveryJob,
} from '@career-workspace/adapters/job-discovery';
import type { DiscoveryCompanyDataset } from '@career-workspace/adapters/discovery-dataset';
import {
  advanceDiscoverySweep,
  getDiscoveryFeed,
  getDiscoveryHealth,
  planDiscoverySweep,
  prepareScheduledDiscovery,
  refreshDiscoveryCatalog,
  refreshDiscoveryPool,
} from './discovery';
import { canonicalJobUrl } from './roles';
import { DISCOVERY_HOST_CONCURRENCY, DISCOVERY_PROVIDERS } from './discovery-policy';

const connectionString = process.env.DATABASE_TEST_URL;
describe.skipIf(!connectionString)('dataset-backed public discovery integration', () => {
  const { database, pool } = createDatabase(connectionString!);
  const userIds: string[] = [];

  function assertTestDatabase() {
    if (new URL(connectionString!).pathname !== '/career_workspace_test') throw new Error('Use career_workspace_test only.');
  }

  async function candidate(targetRoles: string[] = []) {
    const [user] = await database.insert(users).values({ clerkId: `discovery-dataset-${randomUUID()}`, targetRoles }).returning();
    userIds.push(user.id);
    return user.id;
  }

  function source(provider: DiscoveryProvider, board: string): DiscoverySource {
    return { id: `${provider}:${board}`, provider, board, company: `Company ${board}` };
  }

  function dataset(provider: DiscoveryProvider, count: number, rejected = 0): DiscoveryCompanyDataset {
    return {
      sources: Array.from({ length: count }, (_, index) => source(provider, `board-${index.toString().padStart(3, '0')}`)),
      rejected,
    };
  }

  function discoveryJob(sourceId: string, title: string, suffix: string = randomUUID(), postedAt: string | null = null): PublicDiscoveryJob {
    return {
      sourceId,
      provider: sourceId.split(':')[0] as DiscoveryProvider,
      externalId: suffix,
      title,
      company: 'Recorded Example Company',
      location: 'Remote worldwide',
      workMode: 'remote',
      url: `https://boards.greenhouse.io/example/jobs/${suffix}`,
      text: `${title} role. Build and maintain reliable tools with the product team.`,
      postedAt,
    };
  }

  beforeEach(async () => {
    assertTestDatabase();
    for (const userId of userIds) await database.delete(users).where(eq(users.id, userId));
    userIds.splice(0);
    await database.delete(publicJobDiscoveryJobs);
    await database.delete(discoveryJobSightings);
    await database.delete(discoverySweeps);
    await database.delete(publicJobDiscoverySources);
    await database.delete(discoveryCollectionState);
  });

  afterAll(async () => {
    assertTestDatabase();
    for (const userId of userIds) await database.delete(users).where(eq(users.id, userId));
    await pool.end();
  });

  it('caches all provider datasets for 24 hours and records skipped invalid slugs', async () => {
    const fetchDataset = vi.fn(async (provider: DiscoveryProvider) => dataset(provider, 2, provider === 'greenhouse' ? 3 : 0));
    await refreshDiscoveryCatalog({ database, fetchDataset });
    expect(fetchDataset).toHaveBeenCalledTimes(3);
    const [state] = await database.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global'));
    expect(state.datasetFetchedAt).toBeInstanceOf(Date);
    expect(state.datasetError).toBe('INVALID_SLUGS_SKIPPED');
    expect(await database.select().from(publicJobDiscoverySources)).toHaveLength(6);

    const shouldStayCached = vi.fn(async () => { throw new Error('cached dataset fetched again'); });
    await refreshDiscoveryCatalog({ database, fetchDataset: shouldStayCached });
    expect(shouldStayCached).not.toHaveBeenCalled();
  });

  it('persists the sweep cursor and reuses a saved plan on retry', async () => {
    const fetchDataset = vi.fn(async (provider: DiscoveryProvider) => dataset(provider, 12));
    const first = await planDiscoverySweep('recorded-plan-one', { database, fetchDataset, limit: 18 });
    const firstIds = first.flat();
    expect(firstIds).toHaveLength(18);
    for (const provider of DISCOVERY_PROVIDERS)
      expect(firstIds.filter(id => id.startsWith(`${provider}:`))).toHaveLength(DISCOVERY_HOST_CONCURRENCY);

    const [savedPlan] = await database.select().from(discoverySweeps).where(eq(discoverySweeps.key, 'recorded-plan-one'));
    const [stateAfterFirst] = await database.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global'));
    expect(savedPlan.sourceIds).toHaveLength(18);
    expect(stateAfterFirst.cursor).toBe(18);
    await expect(planDiscoverySweep('recorded-plan-one', { database, fetchDataset, limit: 1 })).resolves.toEqual(first);
    expect(fetchDataset).toHaveBeenCalledTimes(3);

    const second = await planDiscoverySweep('recorded-plan-two', { database, fetchDataset, limit: 18 });
    expect(new Set(second.flat()).size).toBe(18);
    expect(second.flat().some(id => firstIds.includes(id))).toBe(false);
    const [stateAfterSecond] = await database.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global'));
    expect(stateAfterSecond.cursor).toBe(0);
  });

  it('keeps the six-provider-board concurrency cap across overlapping runs', async () => {
    await database.insert(discoveryCollectionState).values({ id: 'global' });
    const greenhouseSources = Array.from({ length: 12 }, (_, index) => source('greenhouse', `concurrent-${index}`));
    await database.insert(publicJobDiscoverySources).values(greenhouseSources.map(item => ({ ...item, catalogActive: true })));
    let release: (() => void) | undefined;
    const started = new Promise<void>(resolve => { release = resolve; });
    const pending: Array<() => void> = [];
    let calls = 0;
    const fetchBoard = vi.fn(async () => {
      calls++;
      if (calls === DISCOVERY_HOST_CONCURRENCY) release?.();
      await new Promise<void>(resolve => pending.push(resolve));
      return [];
    });
    const firstRun = refreshDiscoveryPool({ database, force: true, sourceIds: greenhouseSources.slice(0, 6).map(item => item.id), fetchBoard });
    await started;
    const secondRun = await refreshDiscoveryPool({ database, force: true, sourceIds: greenhouseSources.slice(6).map(item => item.id), fetchBoard });
    expect(secondRun).toMatchObject({ refreshed: 0, skipped: 6 });
    expect(calls).toBe(DISCOVERY_HOST_CONCURRENCY);
    for (const finish of pending) finish();
    expect(await firstRun).toMatchObject({ refreshed: 6, failed: 0 });
  });

  it('marks a board dead after three 404s but keeps a 429 refused board retryable', async () => {
    await database.insert(discoveryCollectionState).values({ id: 'global' });
    const [deadSource, refusedSource] = [source('greenhouse', 'dead-example'), source('lever', 'refused-example')];
    await database.insert(publicJobDiscoverySources).values([deadSource, refusedSource].map(item => ({ ...item, catalogActive: true })));
    const fetchBoard = async (item: DiscoverySource) => {
      if (item.id === deadSource.id) throw new DiscoverySourceFetchError('not-found', 'missing', 404);
      throw new DiscoverySourceFetchError('refused', 'throttled', 429, 30_000);
    };
    for (let attempt = 0; attempt < 3; attempt++)
      await refreshDiscoveryPool({ database, force: true, sourceIds: [deadSource.id, refusedSource.id], fetchBoard });

    const rows = await database.select().from(publicJobDiscoverySources);
    const dead = rows.find(row => row.id === deadSource.id)!;
    const refused = rows.find(row => row.id === refusedSource.id)!;
    expect(dead).toMatchObject({ failureCount: 3, errorCode: 'DEAD_BOARD' });
    expect(dead.deadUntilAt).toBeInstanceOf(Date);
    expect(refused).toMatchObject({ failureCount: 0, errorCode: 'SOURCE_REFUSED', deadUntilAt: null });
    expect(refused.nextRetryAt).toBeInstanceOf(Date);
    expect(refused.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('expires postings older than 30 days and does not rejuvenate undated sightings', async () => {
    await database.insert(discoveryCollectionState).values({ id: 'global' });
    const sourceRow = source('greenhouse', 'freshness-example');
    await database.insert(publicJobDiscoverySources).values({ ...sourceRow, catalogActive: true });
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    const oldUndated = discoveryJob(sourceRow.id, 'Software Engineer', 'old-undated');
    const canonical = canonicalJobUrl(oldUndated.url);
    const canonicalHash = createHash('sha256').update(canonical).digest('hex');
    await database.insert(discoveryJobSightings).values({ canonicalUrlHash: canonicalHash, sourceId: sourceRow.id, firstSeenAt: old, lastSeenAt: old });
    const postedTooOld = discoveryJob(sourceRow.id, 'Data Analyst', 'old-posted', old.toISOString());
    const recentPosted = discoveryJob(sourceRow.id, 'Product Designer', 'recent-posted', new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString());
    await refreshDiscoveryPool({ database, force: true, sourceIds: [sourceRow.id], fetchBoard: async () => [postedTooOld, oldUndated, recentPosted] });

    const jobs = await database.select().from(publicJobDiscoveryJobs).where(eq(publicJobDiscoveryJobs.sourceId, sourceRow.id));
    expect(jobs.map(job => job.externalId)).toEqual(['recent-posted']);
    const [sighting] = await database.select().from(discoveryJobSightings).where(eq(discoveryJobSightings.canonicalUrlHash, canonicalHash));
    expect(sighting.firstSeenAt.getTime()).toBe(old.getTime());
    expect(sighting.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it('does not rejuvenate an old undated posting when a user later selects its role', async () => {
    const userId = await candidate([]);
    await database.insert(discoveryCollectionState).values({ id: 'global' });
    const sourceRow = source('greenhouse', 'late-role-example');
    await database.insert(publicJobDiscoverySources).values({ ...sourceRow, catalogActive: true });
    const fixture = discoveryJob(sourceRow.id, 'Chief of Staff', 'late-role-undated');
    const canonicalHash = createHash('sha256').update(canonicalJobUrl(fixture.url)).digest('hex');

    await refreshDiscoveryPool({ database, force: true, sourceIds: [sourceRow.id], fetchBoard: async () => [fixture] });
    let [receipt] = await database.select().from(discoveryJobSightings).where(eq(discoveryJobSightings.canonicalUrlHash, canonicalHash));
    expect(receipt).toBeDefined();
    expect(await database.select().from(publicJobDiscoveryJobs).where(eq(publicJobDiscoveryJobs.canonicalUrlHash, canonicalHash))).toHaveLength(0);

    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    await database.update(discoveryJobSightings).set({ firstSeenAt: old, lastSeenAt: old }).where(eq(discoveryJobSightings.canonicalUrlHash, canonicalHash));
    await database.update(users).set({ targetRoles: ['Chief of Staff'] }).where(eq(users.id, userId));
    await refreshDiscoveryPool({ database, force: true, sourceIds: [sourceRow.id], fetchBoard: async () => [fixture] });

    [receipt] = await database.select().from(discoveryJobSightings).where(eq(discoveryJobSightings.canonicalUrlHash, canonicalHash));
    expect(receipt.firstSeenAt.getTime()).toBe(old.getTime());
    expect(receipt.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    expect(await database.select().from(publicJobDiscoveryJobs).where(eq(publicJobDiscoveryJobs.canonicalUrlHash, canonicalHash))).toHaveLength(0);
  });

  it('keeps user-selected roles plus starter roles in the shared pool', async () => {
    await database.insert(discoveryCollectionState).values({ id: 'global' });
    const targetUser = await candidate(['Project Manager']);
    const newUser = await candidate([]);
    const sourceRow = source('greenhouse', 'role-keep-example');
    await database.insert(publicJobDiscoverySources).values({ ...sourceRow, catalogActive: true });
    const fixtures = [
      discoveryJob(sourceRow.id, 'Project Manager', 'target-role'),
      discoveryJob(sourceRow.id, 'Software Engineer', 'starter-role'),
      discoveryJob(sourceRow.id, 'Chief of Staff', 'outside-keep-list'),
    ];
    await refreshDiscoveryPool({ database, force: true, sourceIds: [sourceRow.id], fetchBoard: async () => fixtures });
    const stored = await database.select().from(publicJobDiscoveryJobs).where(eq(publicJobDiscoveryJobs.sourceId, sourceRow.id));
    expect(stored.map(job => job.title).sort()).toEqual(['Project Manager', 'Software Engineer']);
    expect((await getDiscoveryFeed(targetUser, database)).matches.map(match => match.job.title)).toContain('Project Manager');
    expect((await getDiscoveryFeed(newUser, database)).profileReady).toBe(false);
  });

  it('paginates source health and reports catalog totals', async () => {
    const userId = await candidate();
    await refreshDiscoveryCatalog({ database, fetchDataset: async provider => dataset(provider, 17) });
    const first = await getDiscoveryHealth(userId, 0, database);
    const next = await getDiscoveryHealth(userId, 50, database);
    expect(first).toMatchObject({ sourceTotal: 51, nextOffset: 50, collection: { catalogBoards: 51 } });
    expect(first.sources).toHaveLength(50);
    expect(next.sources).toHaveLength(1);
    expect(next.nextOffset).toBeNull();
  });

  it('stops a scheduled sweep after fifty consecutive provider failures', async () => {
    const key = 'recorded-breaker-sweep';
    const datasetFetch = async (provider: DiscoveryProvider) => dataset(provider, 20);
    await prepareScheduledDiscovery(key, { database, fetchDataset: datasetFetch });
    const result = await advanceDiscoverySweep(key, {
      database,
      collect: options => refreshDiscoveryPool({ ...options, fetchBoard: async () => { throw new DiscoverySourceFetchError('transient', 'unavailable', 503); } }),
      budgetMs: 120_000,
    });
    const [sweep] = await database.select().from(discoverySweeps).where(eq(discoverySweeps.key, key));
    expect(result.halted, JSON.stringify({ result, sweep })).toBe(true);
    expect(result.failed).toBeGreaterThanOrEqual(50);
    expect(result.processed).toBeLessThan(sweep.sourceIds.length);
    expect(sweep.consecutiveFailures).toBeGreaterThanOrEqual(50);
  });
});
