import { createHash } from 'node:crypto';
import { and, desc, eq, getTableColumns, or, sql } from 'drizzle-orm';
import type { DiscoveryFeed, DiscoveryMatch } from '@career-workspace/contracts';
import {
  getDatabase,
  opportunities,
  profileFacts,
  publicJobDiscoveryJobs,
  fitReviews,
  publicJobDiscoverySources,
  discoveryCollectionState,
  users,
  jobs,
  type Database,
} from '@career-workspace/db';
import { isDiscoverySource } from '@career-workspace/adapters/job-discovery';
import { ApiError } from './api';
import { canonicalJobUrl, createJob } from './roles';
import { discoveryFreshness, discoveryKeywords as keywords, matchesTargetRoleTerms } from './discovery-policy';
import { ensureDiscoveryState } from './discovery-catalog';
export { DISCOVERY_BATCH_SIZE, DISCOVERY_MAX_AGE_MS } from './discovery-policy';
export { discoverySourceBatches, planDiscoverySweep, refreshDiscoveryCatalog } from './discovery-catalog';
export { refreshDiscoveryPool } from './discovery-collection';
export { prepareScheduledDiscovery, advanceDiscoverySweep } from './discovery-sweep';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function matchesLocation(location: string, preferred: string): boolean {
  if (!preferred.trim()) return true;
  const listing = location.toLowerCase();
  if (/^remote[\s,·-]*$|worldwide|anywhere|global/.test(listing)) return true;
  const expand = (value: string) => value.toLowerCase()
    .replace(/\b(united kingdom|great britain|britain|uk)\b/g, ' unitedkingdom ')
    .replace(/\b(united states(?: of america)?|usa|us)\b/g, ' unitedstates ');
  const wanted = expand(preferred).match(/[a-z][a-z0-9]{1,}/g) ?? [];
  const offered = new Set(expand(location).match(/[a-z][a-z0-9]{1,}/g) ?? []);
  return wanted.some((term) => offered.has(term));
}

function sourceRows(rows: typeof publicJobDiscoverySources.$inferSelect[], counts = new Map<string, number>()) {
  return rows.filter(isDiscoverySource).map(row => ({
    id: row.id, provider: row.provider as DiscoveryFeed['sources'][number]['provider'], company: row.company, board: row.board,
    status: row.status as DiscoveryFeed['sources'][number]['status'],
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null, lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    error: row.errorCode, activeJobCount: counts.get(row.id) ?? 0,
    verifiedAt: row.verifiedAt?.toISOString() ?? null, deadUntilAt: row.deadUntilAt?.toISOString() ?? null,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null, failureCount: row.failureCount,
  }));
}

async function readHealth(database: Database, offset = 0) {
  const [rows, counts, totals, states] = await Promise.all([
    database.select().from(publicJobDiscoverySources).where(eq(publicJobDiscoverySources.catalogActive, true)).orderBy(publicJobDiscoverySources.id).limit(50).offset(offset),
    database.select({ id: publicJobDiscoveryJobs.sourceId, count: sql<number>`count(*)::int` }).from(publicJobDiscoveryJobs)
      .where(and(eq(publicJobDiscoveryJobs.active, true), discoveryFreshness(), sql`${publicJobDiscoveryJobs.sourceId} IN (SELECT id FROM public_job_discovery_sources WHERE catalog_active = true)`)).groupBy(publicJobDiscoveryJobs.sourceId),
    database.select({ catalog: sql<number>`count(*)::int`, verified: sql<number>`count(*) FILTER (WHERE verified_at IS NOT NULL)::int`,
      dead: sql<number>`count(*) FILTER (WHERE dead_until_at > now())::int`, refused: sql<number>`count(*) FILTER (WHERE error_code = 'SOURCE_REFUSED')::int`,
      latest: sql<Date | string | null>`max(last_success_at)` }).from(publicJobDiscoverySources).where(eq(publicJobDiscoverySources.catalogActive, true)),
    database.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global')),
  ]);
  const total = totals[0];
  const state = states[0];
  return { sources: sourceRows(rows, new Map(counts.map(row => [row.id, row.count]))), sourceTotal: total.catalog,
    nextOffset: offset + rows.length < total.catalog ? offset + rows.length : null,
    totalActiveJobs: counts.reduce((sum, row) => sum + row.count, 0),
    updatedAt: total.latest ? new Date(total.latest).toISOString() : null,
    collection: { catalogBoards: total.catalog, verifiedBoards: total.verified, deadBoards: total.dead, refusedBoards: total.refused,
      datasetFetchedAt: state?.datasetFetchedAt?.toISOString() ?? null, datasetError: state?.datasetError ?? null, cursor: state?.cursor ?? 0 },
  };
}

export async function getDiscoveryHealth(userId: string, offset = 0, database: Database = getDatabase()) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new ApiError(400, 'INVALID_INPUT', 'Choose a valid source page.');
  const [user] = await database.select({ deletion: users.deletionRequestedAt }).from(users).where(eq(users.id, userId));
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
  if (user.deletion) throw new ApiError(403, 'ACCOUNT_DELETION_PENDING', 'Account deletion is in progress.');
  return readHealth(database, offset);
}

export async function getDiscoveryFeed(
  userId: string,
  database: Database = getDatabase(),
): Promise<DiscoveryFeed> {
  const [user] = await database
    .select({ targetRoles: users.targetRoles, preferredLocation: users.preferredLocation, workPreference: users.workPreference, deletionRequestedAt: users.deletionRequestedAt })
    .from(users).where(eq(users.id, userId));
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
  if (user.deletionRequestedAt) throw new ApiError(403, 'ACCOUNT_DELETION_PENDING', 'Account deletion is in progress.');
  const [facts, health] = await Promise.all([
    database.select({ id: profileFacts.id, text: profileFacts.text, kind: profileFacts.kind }).from(profileFacts)
      .where(and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'approved'))),
    readHealth(database),
  ]);
  const targetRoles = user.targetRoles.map(role => role.trim()).filter(Boolean);
  if (!facts.length && !targetRoles.length) return { profileReady: false, targetRoles, matches: [], ...health };
  const searchTerms = [...new Set([...targetRoles.flatMap(role => keywords(role, 2)), ...facts.flatMap(fact => keywords(fact.text))])].slice(0, 40);
  if (!searchTerms.length) return { profileReady: facts.length > 0, targetRoles, matches: [], ...health };
  // Bound per-request memory as the filtered shared pool grows. Saving reads the full description.
  const pool = await database.select({ ...getTableColumns(publicJobDiscoveryJobs), text: sql<string>`left(${publicJobDiscoveryJobs.text}, 12000)` })
    .from(publicJobDiscoveryJobs).where(and(eq(publicJobDiscoveryJobs.active, true), discoveryFreshness(),
      sql`${publicJobDiscoveryJobs.sourceId} IN (SELECT id FROM public_job_discovery_sources WHERE catalog_active = true)`,
      or(...searchTerms.map(term => sql`(${publicJobDiscoveryJobs.title} ILIKE ${`%${term}%`} OR ${publicJobDiscoveryJobs.text} ILIKE ${`%${term}%`})`))))
    .orderBy(sql`${publicJobDiscoveryJobs.lastSeenAt} DESC`, publicJobDiscoveryJobs.id).limit(1000);

  const terms = new Map<string, Set<string>>();
  for (const fact of facts) for (const word of keywords(fact.text)) {
    const ids = terms.get(word) ?? new Set<string>();
    ids.add(fact.id);
    terms.set(word, ids);
  }
  const roleTerms = targetRoles.map(role => ({ role, terms: keywords(role, 2) }));
  const preference = user.workPreference;
  const scored: Array<{ match: DiscoveryMatch; score: number; stable: string }> = [];
  const savedRows = await database.select({
    id: opportunities.id,
    canonicalUrlHash: jobs.canonicalUrlHash,
  }).from(jobs).innerJoin(opportunities, and(
    eq(opportunities.jobId, jobs.id), eq(opportunities.userId, userId),
  ));
  const reviews = await database.select({ opportunityId: fitReviews.opportunityId, scorecard: fitReviews.scorecard }).from(fitReviews).where(eq(fitReviews.userId, userId)).orderBy(desc(fitReviews.createdAt));
  const bands = new Map<string, import('@career-workspace/contracts').FitScoreBand | null>();
  for (const review of reviews) if (!bands.has(review.opportunityId)) bands.set(review.opportunityId, review.scorecard?.band ?? null);
  const savedByHash = new Map(savedRows.map((row) => [row.canonicalUrlHash, row.id]));
  for (const row of pool) {
    if (preference !== 'any' && row.workMode !== preference && row.workMode !== 'unknown') continue;
    if (!matchesLocation(row.location, user.preferredLocation)) continue;
    const titleWords = new Set(keywords(row.title, 2));
    const bodyWords = new Set(keywords(`${row.title} ${row.text}`));
    const matchedTerms: string[] = [];
    const factIds = new Set<string>();
    let score = 0;
    for (const [term, ids] of terms) if (bodyWords.has(term)) {
      matchedTerms.push(term);
      for (const id of ids) factIds.add(id);
      score += titleWords.has(term) ? 5 : 1;
    }
    const matchedRoles: string[] = [];
    for (const target of roleTerms) {
      if (!matchesTargetRoleTerms(titleWords, target.terms)) continue;
      matchedRoles.push(target.role);
      for (const term of target.terms) if (titleWords.has(term)) {
        if (!matchedTerms.includes(term)) matchedTerms.push(term);
        score += 3;
      }
    }
    if (!score) continue;
    const savedOpportunityId = savedByHash.get(hash(canonicalJobUrl(row.url))) ?? null;
    const job = {
      id: row.id,
      sourceId: row.sourceId,
      provider: row.sourceId.split(':')[0] as DiscoveryMatch['job']['provider'],
      externalId: row.externalId,
      title: row.title,
      company: row.company,
      location: row.location,
      workMode: row.workMode as DiscoveryMatch['job']['workMode'],
      url: row.url,
      text: row.text,
      postedAt: row.postedAt?.toISOString() ?? null,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      active: row.active,
    };
    scored.push({
      score,
      stable: `${row.title.toLowerCase()}\0${row.company.toLowerCase()}\0${row.id}`,
      match: {
        job,
        matchedTerms: matchedTerms.sort(),
        factIds: [...factIds].sort(),
        reasons: [
          ...[...factIds]
            .map(id => facts.find(fact => fact.id === id)?.text)
            .filter((text): text is string => Boolean(text))
            .map(text => `Matches your approved profile: ${text}`),
          ...matchedRoles.map(role => `Matches target role: ${role}`),
        ],
        savedOpportunityId,
        fitBand: savedOpportunityId ? bands.get(savedOpportunityId) ?? null : null,
      },
    });
  }
  scored.sort((a, b) => b.score - a.score || a.stable.localeCompare(b.stable));
  return {
    profileReady: facts.length > 0,
    targetRoles,
    matches: scored.slice(0, 100).map(({ match }) => match),
    ...health,
  };
}

export async function saveDiscoveredJob(
  userId: string,
  discoveryJobId: string,
  database?: Database,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(discoveryJobId))
    throw new ApiError(404, 'NOT_FOUND', 'This job is no longer available.');
  const db = database ?? getDatabase();
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ deletionRequestedAt: users.deletionRequestedAt }).from(users).where(eq(users.id, userId)).for('update');
    if (!owner) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
    if (owner.deletionRequestedAt) throw new ApiError(403, 'ACCOUNT_DELETION_PENDING', 'Account deletion is in progress.');
    const [discovered] = await tx.select().from(publicJobDiscoveryJobs)
      .where(and(eq(publicJobDiscoveryJobs.id, discoveryJobId), eq(publicJobDiscoveryJobs.active, true), discoveryFreshness(), sql`${publicJobDiscoveryJobs.sourceId} IN (SELECT id FROM public_job_discovery_sources WHERE catalog_active = true)`));
    if (!discovered) throw new ApiError(404, 'NOT_FOUND', 'This job is no longer available.');
    return createJob(userId, {
      title: discovered.title,
      company: discovered.company,
      location: discovered.location,
      url: discovered.canonicalUrl,
      text: discovered.text,
    }, { database: tx });
  });
}

/** Keep scheduler failure visible even before a directory has ever loaded. */
export async function recordDiscoveryStartFailure(database: Database = getDatabase()) {
  await ensureDiscoveryState(database);
  await database.update(discoveryCollectionState).set({ datasetError: 'WORKFLOW_START_FAILED' }).where(eq(discoveryCollectionState.id, 'global'));
}
