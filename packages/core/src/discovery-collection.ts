import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { discoveryCollectionState, discoverySweeps, discoveryJobSightings, publicJobDiscoveryJobs as jobs, publicJobDiscoverySources as sources, users, getDatabase, type Database } from '@career-workspace/db';
import { fetchDiscoveryBoard, DiscoverySourceFetchError, type DiscoverySource } from '@career-workspace/adapters/job-discovery';
import { ensureDiscoveryState, planDiscoverySweep, readDiscoverySources } from './discovery-catalog';
import { DISCOVERY_BATCH_SIZE, DISCOVERY_FAILURE_LIMIT, DISCOVERY_HOST_CONCURRENCY, DISCOVERY_MAX_AGE_MS, keepDiscoveryTitle } from './discovery-policy';
import { canonicalJobUrl } from './roles';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function refreshDiscoveryPool(options: {
  database?: Database; fetchBoard?: typeof fetchDiscoveryBoard; force?: boolean;
  sourceIds?: string[]; sweepKey?: string;
} = {}) {
  const database = options.database ?? getDatabase();
  await ensureDiscoveryState(database);
  const sourceIds = options.sourceIds ?? (await planDiscoverySweep(`manual:${randomUUID()}`, { database, limit: DISCOVERY_BATCH_SIZE })).flat();
  const selected = await readDiscoverySources(database, sourceIds);
  const targets = await database.select({ roles: users.targetRoles }).from(users).where(sql`${users.deletionRequestedAt} IS NULL`);
  const targetRoles = [...new Set(targets.flatMap(user => user.roles))];
  if (options.sweepKey) {
    const [sweep] = await database.select().from(discoverySweeps).where(eq(discoverySweeps.key, options.sweepKey));
    if (!sweep || sweep.halted) return { refreshed: 0, failed: 0, skipped: selected.length, halted: true };
  }
  const staleBefore = new Date(Date.now() - 2 * 60_000);
  const cooldownBefore = new Date(Date.now() - 15 * 60_000);
  const settled = await Promise.allSettled(selected.map(async source => {
    const token = randomUUID();
    const claimed = await database.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '1000ms'`);
      // This short global lock makes the six slots per ATS apply across concurrent runs.
      await tx.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global')).for('update');
      const [row] = await tx.select().from(sources).where(eq(sources.id, source.id)).for('update');
      if (!row?.catalogActive || (row.deadUntilAt && row.deadUntilAt > new Date())) return false;
      if (row.status === 'running' && row.lastAttemptAt && row.lastAttemptAt > staleBefore) return false;
      if (!options.force && ((row.nextRetryAt && row.nextRetryAt > new Date()) || (row.status !== 'running' && row.lastAttemptAt && row.lastAttemptAt > cooldownBefore))) return false;
      const [busy] = await tx.select({ count: sql<number>`count(*)::int` }).from(sources).where(and(eq(sources.provider, source.provider), eq(sources.status, 'running'), gte(sources.lastAttemptAt, staleBefore)));
      if (busy.count >= DISCOVERY_HOST_CONCURRENCY) return false;
      await tx.update(sources).set({ status: 'running', lastAttemptAt: new Date(), errorCode: null, claimToken: token }).where(eq(sources.id, source.id));
      return true;
    });
    if (!claimed) return 'skipped' as const;
    try {
      const discovered = await (options.fetchBoard ?? fetchDiscoveryBoard)(source as DiscoverySource, { timeoutMs: 8_000 });
      const now = new Date();
      // Establish completeness before closing any disappeared jobs, even filtered rows.
      for (const job of discovered) {
        if (job.sourceId !== source.id || !job.externalId.trim() || !job.title.trim() || !job.company.trim() || !job.text.trim()) throw new Error('Incomplete board.');
        canonicalJobUrl(job.url);
      }
      // Keep a thin receipt for every valid posting, including titles outside
      // today's keep-list. That preserves the original age if a user adds a
      // matching target role later; full job text is still stored only for kept roles.
      const sightings = [...new Map(discovered.map(job => {
        const url = canonicalJobUrl(job.url);
        return [hash(url), { job, url, hash: hash(url) }];
      })).values()];
      const candidates = sightings.filter(({ job }) => keepDiscoveryTitle(job.title, targetRoles));
      await database.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '1000ms'`);
        const [owned] = await tx.select().from(sources).where(and(eq(sources.id, source.id), eq(sources.claimToken, token))).for('update');
        if (!owned) return;
        for (let offset = 0; offset < sightings.length; offset += 500) {
          await tx.insert(discoveryJobSightings).values(sightings.slice(offset, offset + 500).map(item => ({ canonicalUrlHash: item.hash, sourceId: source.id, firstSeenAt: now, lastSeenAt: now })))
            .onConflictDoUpdate({ target: discoveryJobSightings.canonicalUrlHash, set: { lastSeenAt: now, sourceId: source.id } });
        }
        const seen = candidates.length ? await tx.select().from(discoveryJobSightings).where(inArray(discoveryJobSightings.canonicalUrlHash, candidates.map(item => item.hash))) : [];
        const firstSeen = new Map(seen.map(row => [row.canonicalUrlHash, row.firstSeenAt]));
        const values = candidates.flatMap(({ job, url, hash: urlHash }) => {
          const postedAt = job.postedAt ? new Date(job.postedAt) : null;
          const firstSeenAt = firstSeen.get(urlHash)!;
          const freshAt = postedAt ?? firstSeenAt;
          if (!Number.isFinite(freshAt.getTime()) || freshAt > now || freshAt.getTime() < now.getTime() - DISCOVERY_MAX_AGE_MS) return [];
          return [{ sourceId: source.id, externalId: job.externalId, canonicalUrl: url, canonicalUrlHash: urlHash,
            title: job.title.trim(), company: job.company.trim(), location: job.location.trim(), workMode: job.workMode,
            url: job.url, text: job.text, postedAt, firstSeenAt, lastSeenAt: now, active: true }];
        });
        for (let offset = 0; offset < values.length; offset += 500) {
          await tx.insert(jobs).values(values.slice(offset, offset + 500)).onConflictDoUpdate({ target: jobs.canonicalUrlHash,
            set: { sourceId: sql`excluded.source_id`, externalId: sql`excluded.external_id`, canonicalUrl: sql`excluded.canonical_url`, title: sql`excluded.title`, company: sql`excluded.company`, location: sql`excluded.location`, workMode: sql`excluded.work_mode`, url: sql`excluded.url`, text: sql`excluded.text`, postedAt: sql`excluded.posted_at`, firstSeenAt: sql`excluded.first_seen_at`, lastSeenAt: now, active: true } });
        }
        const kept = values.map(value => value.canonicalUrlHash);
        await tx.delete(jobs).where(and(eq(jobs.sourceId, source.id), kept.length ? sql`${jobs.canonicalUrlHash} NOT IN (${sql.join(kept.map(value => sql`${value}`), sql`, `)})` : undefined));
        await tx.update(sources).set({ status: 'succeeded', lastSuccessAt: now, verifiedAt: discovered.length ? now : null, failureCount: 0, deadUntilAt: null, nextRetryAt: null, errorCode: discovered.length ? null : 'EMPTY_BOARD', claimToken: null })
          .where(and(eq(sources.id, source.id), eq(sources.claimToken, token)));
      });
      return 'refreshed' as const;
    } catch (cause) {
      const kind = cause instanceof DiscoverySourceFetchError ? cause.kind : 'transient';
      await database.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '1000ms'`);
        const [row] = await tx.select().from(sources).where(and(eq(sources.id, source.id), eq(sources.claimToken, token))).for('update');
        if (!row) return;
        const failureCount = kind === 'not-found' ? row.failureCount + 1 : 0;
        const dead = failureCount >= 3;
        const retryMs = kind === 'refused' && cause instanceof DiscoverySourceFetchError ? Math.max(15 * 60_000, Math.min(cause.retryAfterMs ?? 0, 24 * 60 * 60_000)) : 15 * 60_000;
        await tx.update(sources).set({ status: 'failed', failureCount, deadUntilAt: dead ? new Date(Date.now() + DISCOVERY_MAX_AGE_MS) : null,
          nextRetryAt: new Date(Date.now() + (dead ? DISCOVERY_MAX_AGE_MS : retryMs)),
          errorCode: dead ? 'DEAD_BOARD' : kind === 'not-found' ? 'BOARD_NOT_FOUND' : kind === 'refused' ? 'SOURCE_REFUSED' : kind === 'malformed' ? 'SOURCE_MALFORMED' : 'SOURCE_UNAVAILABLE', claimToken: null })
          .where(and(eq(sources.id, source.id), eq(sources.claimToken, token)));
        if (dead) await tx.delete(jobs).where(eq(jobs.sourceId, source.id));
      });
      return 'failed' as const;
    }
  }));
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  const outcomes = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  let halted = false;
  if (options.sweepKey) {
    halted = await database.transaction(async tx => {
      const [sweep] = await tx.select().from(discoverySweeps).where(eq(discoverySweeps.key, options.sweepKey!)).for('update');
      if (!sweep) return true;
      let failures = sweep.consecutiveFailures;
      let stop = sweep.halted;
      for (const outcome of outcomes) {
        if (outcome === 'refreshed') failures = 0; else if (outcome === 'failed') failures++;
        if (failures >= DISCOVERY_FAILURE_LIMIT) stop = true;
      }
      await tx.update(discoverySweeps).set({ consecutiveFailures: failures, halted: stop }).where(eq(discoverySweeps.key, sweep.key));
      return stop;
    });
  }
  return { refreshed: outcomes.filter(value => value === 'refreshed').length, failed: outcomes.filter(value => value === 'failed').length, skipped: outcomes.filter(value => value === 'skipped').length, halted };
}
