import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { discoveryCollectionState, discoverySweeps, discoveryJobSightings, publicJobDiscoverySources as sources, publicJobDiscoveryJobs as jobs, getDatabase, type Database } from '@career-workspace/db';
import { isDiscoverySource } from '@career-workspace/adapters/job-discovery';
import { fetchDiscoveryCompanyDataset } from '@career-workspace/adapters/discovery-dataset';
import { ApiError } from './api';
import { DISCOVERY_BATCH_SIZE, DISCOVERY_DATASET_CACHE_MS, DISCOVERY_HOST_CONCURRENCY, DISCOVERY_PROVIDERS, DISCOVERY_SWEEP_SIZE, discoveryFreshness } from './discovery-policy';

export async function ensureDiscoveryState(database: Database) {
  await database.insert(discoveryCollectionState).values({ id: 'global' }).onConflictDoNothing();
}

/** Only successful complete downloads replace the stored, validated 24-hour directory. */
export async function refreshDiscoveryCatalog(options: {
  database?: Database; fetchDataset?: typeof fetchDiscoveryCompanyDataset; force?: boolean;
} = {}) {
  const database = options.database ?? getDatabase();
  await ensureDiscoveryState(database);
  const token = randomUUID();
  const claimed = await database.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    const [state] = await tx.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global')).for('update');
    const now = Date.now();
    if (!options.force && state.datasetFetchedAt && now - state.datasetFetchedAt.getTime() < DISCOVERY_DATASET_CACHE_MS) return false;
    if (state.datasetClaimedAt && now - state.datasetClaimedAt.getTime() < 2 * 60_000) return false;
    if (!options.force && state.datasetAttemptAt && now - state.datasetAttemptAt.getTime() < 15 * 60_000) return false;
    await tx.update(discoveryCollectionState).set({ datasetClaimToken: token, datasetClaimedAt: new Date(), datasetAttemptAt: new Date() }).where(eq(discoveryCollectionState.id, 'global'));
    return true;
  });
  if (claimed) {
    try {
      const downloaded = await Promise.all(DISCOVERY_PROVIDERS.map(provider => (options.fetchDataset ?? fetchDiscoveryCompanyDataset)(provider)));
      const catalog = downloaded.flatMap(result => result.sources);
      if (!catalog.length || catalog.length > 60_000 || catalog.some(source => !isDiscoverySource(source))) throw new Error('Invalid directory.');
      if (DISCOVERY_PROVIDERS.some(provider => !catalog.some(source => source.provider === provider))) throw new Error('Incomplete directory.');
      const unique = [...new Map(catalog.map(source => [source.id, source])).values()];
      await database.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
        const [state] = await tx.select().from(discoveryCollectionState).where(and(eq(discoveryCollectionState.id, 'global'), eq(discoveryCollectionState.datasetClaimToken, token))).for('update');
        if (!state) return;
        await tx.update(sources).set({ catalogActive: false });
        for (let offset = 0; offset < unique.length; offset += 500) {
          await tx.insert(sources).values(unique.slice(offset, offset + 500).map(source => ({ ...source, catalogActive: true })))
            .onConflictDoUpdate({ target: sources.id, set: { catalogActive: true, company: sql`excluded.company`, provider: sql`excluded.provider`, board: sql`excluded.board` } });
        }
        await tx.delete(jobs).where(sql`${jobs.sourceId} IN (SELECT id FROM public_job_discovery_sources WHERE catalog_active = false)`);
        await tx.update(discoveryCollectionState).set({ datasetFetchedAt: new Date(), datasetError: downloaded.some(result => result.rejected > 0) ? 'INVALID_SLUGS_SKIPPED' : null, datasetClaimToken: null, datasetClaimedAt: null }).where(eq(discoveryCollectionState.id, 'global'));
      });
    } catch {
      await database.update(discoveryCollectionState).set({ datasetError: 'DATASET_UNAVAILABLE', datasetClaimToken: null, datasetClaimedAt: null })
        .where(and(eq(discoveryCollectionState.id, 'global'), eq(discoveryCollectionState.datasetClaimToken, token)));
    }
  }
  const [state] = await database.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global'));
  if (!state.datasetFetchedAt) throw new ApiError(503, 'DISCOVERY_DATASET_UNAVAILABLE', 'The company directory is being collected or is temporarily unavailable. Check again shortly.');
  return state;
}

export function discoverySourceBatches(sourceIds: string[]) {
  const queues = DISCOVERY_PROVIDERS.map(provider => sourceIds.filter(id => id.startsWith(`${provider}:`)));
  const batches: string[][] = [];
  while (queues.some(queue => queue.length)) batches.push(queues.flatMap(queue => queue.splice(0, DISCOVERY_HOST_CONCURRENCY)));
  return batches;
}

/** A saved plan makes workflow retries reuse the same reservation and cursor advance. */
export async function planDiscoverySweep(key: string, options: { database?: Database; fetchDataset?: typeof fetchDiscoveryCompanyDataset; limit?: number; all?: boolean } = {}) {
  const database = options.database ?? getDatabase();
  if (!key || key.length > 240) throw new ApiError(400, 'INVALID_INPUT', 'Provide a collection key.');
  const [existing] = await database.select().from(discoverySweeps).where(eq(discoverySweeps.key, key));
  if (existing) return discoverySourceBatches(existing.sourceIds);
  await refreshDiscoveryCatalog(options);
  // Full descriptions disappear after expiry; narrow sightings preserve undated age.
  await database.delete(jobs).where(sql`NOT (${discoveryFreshness()})`);
  await database.delete(discoveryJobSightings).where(lt(discoveryJobSightings.lastSeenAt, new Date(Date.now() - 90 * 24 * 60 * 60_000)));
  await database.delete(discoverySweeps).where(and(lt(discoverySweeps.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60_000)), sql`${discoverySweeps.nextIndex} >= jsonb_array_length(${discoverySweeps.sourceIds})`));
  return database.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    const [state] = await tx.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global')).for('update');
    const [replay] = await tx.select().from(discoverySweeps).where(eq(discoverySweeps.key, key));
    if (replay) return discoverySourceBatches(replay.sourceIds);
    const catalog = (await tx.select().from(sources).where(eq(sources.catalogActive, true))).filter(isDiscoverySource);
    const queues = DISCOVERY_PROVIDERS.map(provider => catalog.filter(source => source.provider === provider).sort((a, b) => a.id.localeCompare(b.id)));
    const ordered: typeof catalog = [];
    for (let index = 0; queues.some(queue => index < queue.length); index++) for (const queue of queues) if (queue[index]) ordered.push(queue[index]);
    const limit = options.all ? ordered.length : Math.min(DISCOVERY_SWEEP_SIZE, Math.max(1, options.limit ?? DISCOVERY_SWEEP_SIZE));
    const ids: string[] = [];
    let visited = 0;
    while (visited < ordered.length && ids.length < limit) {
      const source = ordered[(state.cursor + visited) % ordered.length] as typeof catalog[number];
      visited++;
      if (source.deadUntilAt && source.deadUntilAt > new Date()) continue;
      if (source.nextRetryAt && source.nextRetryAt > new Date()) continue;
      ids.push(source.id);
    }
    await tx.insert(discoverySweeps).values({ key, sourceIds: ids });
    await tx.update(discoveryCollectionState).set({ cursor: options.all ? 0 : ordered.length ? (state.cursor + visited) % ordered.length : 0 }).where(eq(discoveryCollectionState.id, 'global'));
    return discoverySourceBatches(ids);
  });
}

export async function readDiscoverySources(database: Database, ids: string[]) {
  if (ids.length > DISCOVERY_BATCH_SIZE || DISCOVERY_PROVIDERS.some(provider => ids.filter(id => id.startsWith(`${provider}:`)).length > DISCOVERY_HOST_CONCURRENCY)) throw new ApiError(400, 'INVALID_INPUT', 'Choose a bounded discovery batch.');
  const rows = ids.length ? await database.select().from(sources).where(inArray(sources.id, ids)) : [];
  if (rows.length !== new Set(ids).size || rows.some(row => !isDiscoverySource(row))) throw new ApiError(400, 'INVALID_INPUT', 'Choose a board in the validated directory.');
  return rows.filter(row => row.catalogActive);
}
