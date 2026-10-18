/** Bounded live-board collection against the isolated career_workspace_test database. */
import { randomUUID } from 'node:crypto';
import { and, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  createDatabase,
  discoveryCollectionState,
  discoverySweeps,
  publicJobDiscoveryJobs,
  publicJobDiscoverySources,
} from '@career-workspace/db';
import { refreshDiscoveryCatalog, planDiscoverySweep, advanceDiscoverySweep, DISCOVERY_MAX_AGE_MS } from '@career-workspace/core/discovery';

const rawUrl = process.env.DATABASE_TEST_URL;
const parsed = rawUrl ? new URL(rawUrl) : null;
if (!parsed || !['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash
  || parsed.pathname !== '/career_workspace_test' || !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
  throw new Error('Collection verification requires DATABASE_TEST_URL for the local career_workspace_test database.');
}

const MAX_SAMPLE_BOARDS = 30;
const MAX_STEP_CALLS = 6;
const databaseUrl = parsed.href;
const { database, pool } = createDatabase(databaseUrl);
const sweepKey = `bounded-verification:${randomUUID()}`;

try {
  // This downloads and stores the validated directory, but only reserves at most
  // 30 boards for live collection. It never starts the full scheduled sweep.
  await refreshDiscoveryCatalog({ database, force: true });
  const batches = await planDiscoverySweep(sweepKey, { database, limit: MAX_SAMPLE_BOARDS });
  const plannedSourceIds = batches.flat();
  let progress: Awaited<ReturnType<typeof advanceDiscoverySweep>> | null = null;
  const steps: Array<Record<string, unknown>> = [];
  for (let index = 0; index < MAX_STEP_CALLS; index += 1) {
    const startedAt = Date.now();
    progress = await advanceDiscoverySweep(sweepKey, { database, budgetMs: 40_000 });
    steps.push({ call: index + 1, processed: progress.processed, total: progress.total, milliseconds: Date.now() - startedAt, busy: progress.busy, halted: progress.halted });
    if (progress.done || progress.busy) break;
  }

  const [sweep] = await database.select().from(discoverySweeps).where(eq(discoverySweeps.key, sweepKey));
  const [catalogCount] = await database.select({ count: count() }).from(publicJobDiscoverySources)
    .where(eq(publicJobDiscoverySources.catalogActive, true));
  const [collectionState] = await database.select({ datasetFetchedAt: discoveryCollectionState.datasetFetchedAt, datasetError: discoveryCollectionState.datasetError })
    .from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global'));
  const sampleIds = plannedSourceIds.length ? plannedSourceIds : [];
  const [jobsCount] = sampleIds.length
    ? await database.select({ count: count() }).from(publicJobDiscoveryJobs)
      .where(and(eq(publicJobDiscoveryJobs.active, true), inArray(publicJobDiscoveryJobs.sourceId, sampleIds),
        gte(sql`coalesce(${publicJobDiscoveryJobs.postedAt}, ${publicJobDiscoveryJobs.firstSeenAt})`, new Date(Date.now() - DISCOVERY_MAX_AGE_MS)),
        lte(sql`coalesce(${publicJobDiscoveryJobs.postedAt}, ${publicJobDiscoveryJobs.firstSeenAt})`, new Date()),
        gte(publicJobDiscoveryJobs.lastSeenAt, new Date(Date.now() - DISCOVERY_MAX_AGE_MS))))
    : [{ count: 0 }];
  const sourceRows = sampleIds.length
    ? await database.select({ id: publicJobDiscoverySources.id, provider: publicJobDiscoverySources.provider, status: publicJobDiscoverySources.status,
      errorCode: publicJobDiscoverySources.errorCode, failureCount: publicJobDiscoverySources.failureCount, verifiedAt: publicJobDiscoverySources.verifiedAt })
      .from(publicJobDiscoverySources).where(inArray(publicJobDiscoverySources.id, sampleIds))
    : [];
  const result = {
    checkedAt: new Date().toISOString(),
    scope: 'bounded local database sample; never a full live sweep',
    maxSampleBoards: MAX_SAMPLE_BOARDS,
    datasetCatalogBoards: catalogCount.count,
    datasetFetchedAt: collectionState?.datasetFetchedAt?.toISOString() ?? null,
    datasetError: collectionState?.datasetError ?? null,
    sweep: sweep ? { plannedBoards: sweep.sourceIds.length, processedBoards: sweep.nextIndex, done: sweep.nextIndex >= sweep.sourceIds.length,
      halted: sweep.halted, refreshed: sweep.refreshed, failed: sweep.failed, skipped: sweep.skipped } : null,
    activeFreshJobsInSample: jobsCount.count,
    stepCalls: steps,
    sampleSources: sourceRows,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!sweep || sweep.halted || sweep.nextIndex < sweep.sourceIds.length) process.exitCode = 1;
} finally {
  await pool.end();
}
