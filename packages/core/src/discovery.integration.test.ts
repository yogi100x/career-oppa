import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, discoveryCollectionState, discoveryJobSightings, discoverySweeps, profileFacts, publicJobDiscoveryJobs, publicJobDiscoverySources, users } from '@career-workspace/db';
import { eq } from 'drizzle-orm';
import { DISCOVERY_SOURCES, type PublicDiscoveryJob } from '@career-workspace/adapters/job-discovery';
import { DISCOVERY_BATCH_SIZE, discoverySourceBatches, getDiscoveryFeed, recordDiscoveryStartFailure, refreshDiscoveryPool, saveDiscoveredJob } from './discovery';

const connectionString = process.env.DATABASE_TEST_URL;
describe.skipIf(!connectionString)('job discovery core', () => {
  const { database, pool } = createDatabase(connectionString!);
  const userIds: string[] = [];
  async function candidate() {
    if (new URL(connectionString!).pathname !== '/career_workspace_test') throw new Error('Use career_workspace_test only.');
    const [user] = await database.insert(users).values({ clerkId: `discovery-${randomUUID()}`, targetRoles: ['Software Engineer'] }).returning();
    userIds.push(user.id);
    return user.id;
  }
  beforeEach(async () => {
    if (new URL(connectionString!).pathname !== '/career_workspace_test') throw new Error('Use career_workspace_test only.');
    for (const userId of userIds) await database.delete(users).where(eq(users.id, userId));
    userIds.splice(0);
    // The public pool is shared; isolate recorded fixtures from diagnostic collections.
    await database.delete(publicJobDiscoveryJobs);
    await database.delete(discoveryJobSightings);
    await database.delete(discoverySweeps);
    await database.delete(publicJobDiscoverySources);
    await database.delete(discoveryCollectionState);
    await database.insert(publicJobDiscoverySources).values(DISCOVERY_SOURCES.map(source => ({ ...source, catalogActive: true })));
  });
  afterAll(async () => {
    for (const userId of userIds) await database.delete(users).where(eq(users.id, userId));
    await pool.end();
  });

  it('matches approved facts only, keeps the public pool shared, and saves into owned roles', async () => {
    const userId = await candidate();
    const [fact] = await database.insert(profileFacts).values({
      userId, kind: 'skill', text: 'TypeScript and API design', source: 'user', status: 'approved',
    }).returning();
    const url = `https://boards.greenhouse.io/figma/jobs/${randomUUID()}`;
    const fixture: PublicDiscoveryJob = {
      sourceId: DISCOVERY_SOURCES[0]!.id,
      provider: 'greenhouse', externalId: randomUUID(), title: 'Senior TypeScript Engineer', company: 'Figma',
      location: 'Remote', workMode: 'remote', url,
      text: 'Build TypeScript services with a thoughtful engineering team. Work with product designers, improve reliable systems, and ship clear customer features across the platform.',
      postedAt: null,
    };
    const result = await refreshDiscoveryPool({ database, sourceIds: [DISCOVERY_SOURCES[0]!.id], force: true, fetchBoard: async (source) => source.id === fixture.sourceId ? [fixture] : [] });
    expect(result.failed).toBe(0);
    const feed = await getDiscoveryFeed(userId, database);
    expect(feed.profileReady).toBe(true);
    const match = feed.matches.find((item) => item.job.url === url);
    expect(match).toMatchObject({
      matchedTerms: ['typescript'],
      factIds: [fact.id],
      reasons: ['Matches your approved profile: TypeScript and API design'],
    });
    expect(match?.job.text).not.toContain('CV');
    const saved = await saveDiscoveredJob(userId, match!.job.id, database);
    expect(saved.opportunity.userId).toBe(userId);
    expect((await getDiscoveryFeed(userId, database)).matches.find((item) => item.job.url === url)?.savedOpportunityId).toBe(saved.opportunity.id);
  });

  it('preserves active jobs after a malformed board row and closes them after a complete empty scan', async () => {
    const url = `https://boards.greenhouse.io/figma/jobs/${randomUUID()}`;
    const fixture: PublicDiscoveryJob = {
      sourceId: DISCOVERY_SOURCES[0]!.id, provider: 'greenhouse', externalId: randomUUID(),
      title: 'TypeScript Engineer', company: 'Figma', location: 'Remote', workMode: 'remote', url,
      text: 'Build TypeScript systems.', postedAt: null,
    };
    await refreshDiscoveryPool({ database, sourceIds: [DISCOVERY_SOURCES[0]!.id], force: true, fetchBoard: async source => source.id === fixture.sourceId ? [fixture] : [] });
    const [active] = await database.select().from(publicJobDiscoveryJobs).where(eq(publicJobDiscoveryJobs.canonicalUrl, url));
    expect(active?.active).toBe(true);

    const cooledFetch = vi.fn(async () => []);
    const cooled = await refreshDiscoveryPool({ database, sourceIds: [DISCOVERY_SOURCES[0]!.id], fetchBoard: cooledFetch });
    expect(cooled.refreshed).toBe(0);
    expect(cooledFetch).not.toHaveBeenCalled();

    const malformed = { ...fixture, text: '' };
    const failed = await refreshDiscoveryPool({ database, sourceIds: [DISCOVERY_SOURCES[0]!.id], force: true, fetchBoard: async source => source.id === fixture.sourceId ? [malformed] : [] });
    expect(failed.failed).toBe(1);
    const [preserved] = await database.select().from(publicJobDiscoveryJobs).where(eq(publicJobDiscoveryJobs.canonicalUrl, url));
    expect(preserved?.active).toBe(true);

    const complete = await refreshDiscoveryPool({ database, sourceIds: [DISCOVERY_SOURCES[0]!.id], force: true, fetchBoard: async () => [] });
    expect(complete.failed).toBe(0);
    const closed = await database.select().from(publicJobDiscoveryJobs).where(eq(publicJobDiscoveryJobs.canonicalUrl, url));
    expect(closed).toHaveLength(0);
  });

  it('respects country restrictions on remote jobs and accepts worldwide listings', async () => {
    const userId = await candidate();
    await database.update(users).set({ preferredLocation: 'UK', workPreference: 'remote' }).where(eq(users.id, userId));
    await database.insert(profileFacts).values({ userId, kind: 'skill', text: 'TypeScript', source: 'user', status: 'approved' });
    const fixture = (location: string): PublicDiscoveryJob => ({
      sourceId: DISCOVERY_SOURCES[0]!.id, provider: 'greenhouse', externalId: randomUUID(),
      title: 'TypeScript Engineer', company: 'Figma', location, workMode: 'remote',
      url: `https://boards.greenhouse.io/figma/jobs/${randomUUID()}`,
      text: 'TypeScript engineer builds reliable applications and improves the product with the team. This is a full time software engineering role with documented requirements.', postedAt: null,
    });
    const postings = [fixture('Remote, United States'), fixture('Remote, United Kingdom'), fixture('Remote worldwide')];
    await refreshDiscoveryPool({ database, sourceIds: [DISCOVERY_SOURCES[0]!.id], force: true, fetchBoard: async source => source.id === DISCOVERY_SOURCES[0]!.id ? postings : [] });
    const feed = await getDiscoveryFeed(userId, database);
    expect(feed.matches.map(match => match.job.location).sort()).toEqual(['Remote worldwide', 'Remote, United Kingdom'].sort());
  });

  it('does not expose matches before the user approves a profile fact', async () => {
    const userId = await candidate();
    await database.update(users).set({ targetRoles: [] }).where(eq(users.id, userId));
    await database.insert(profileFacts).values({ userId, kind: 'skill', text: 'Ruby engineer', source: 'user', status: 'proposed' });
    const feed = await getDiscoveryFeed(userId, database);
    expect(feed).toMatchObject({ profileReady: false, matches: [] });
  });


  it('partitions the seeded boards into per-provider batches and respects cooldown', async () => {
    const ids = DISCOVERY_SOURCES.map(source => source.id);
    const batches = discoverySourceBatches(ids);
    expect(new Set(batches.flat())).toEqual(new Set(ids));
    expect(batches.every(batch => batch.length <= DISCOVERY_BATCH_SIZE)).toBe(true);
    for (const batch of batches) for (const provider of ['greenhouse', 'lever', 'ashby'])
      expect(batch.filter(id => id.startsWith(`${provider}:`)).length).toBeLessThanOrEqual(6);
    await candidate();
    await getDiscoveryFeed(userIds.at(-1)!, database);
    const seen: string[] = [];
    const fetchBoard = vi.fn(async (source: typeof DISCOVERY_SOURCES[number]) => { seen.push(source.id); return []; });
    expect((await refreshDiscoveryPool({ database, sourceIds: ids, force: true, fetchBoard })).refreshed).toBe(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
    const cooled = await refreshDiscoveryPool({ database, sourceIds: ids, fetchBoard });
    expect(cooled.refreshed).toBe(0);
    expect(cooled.skipped).toBe(ids.length);
    expect(seen).toHaveLength(ids.length);
    await expect(refreshDiscoveryPool({ database, sourceIds: ['unknown:board'], fetchBoard })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('shows target-only matches, source counts, and hides stale or removed jobs', async () => {
    const userId = await candidate();
    await database.update(users).set({ targetRoles: ['DevOps engineer'] }).where(eq(users.id, userId));
    const fixture = (title: string): PublicDiscoveryJob => ({
      sourceId: DISCOVERY_SOURCES[0]!.id, provider: 'greenhouse', externalId: randomUUID(),
      title, company: 'Figma', location: 'Remote', workMode: 'remote',
      url: `https://boards.greenhouse.io/figma/jobs/${randomUUID()}`, text: 'Operate cloud infrastructure and delivery pipelines.', postedAt: null,
    });
    const postings = [fixture('DevOps Engineer'), fixture('Senior DevOps Engineer'), fixture('Software Engineer')];
    await refreshDiscoveryPool({ database, sourceIds: [postings[0]!.sourceId], force: true, fetchBoard: async () => postings });
    const feed = await getDiscoveryFeed(userId, database);
    const matchTitles = feed.matches.map(item => item.job.title);
    expect(matchTitles).toContain('DevOps Engineer');
    expect(matchTitles).toContain('Senior DevOps Engineer');
    expect(matchTitles).not.toContain('Software Engineer');
    const match = feed.matches.find(item => item.job.title === 'DevOps Engineer')!;
    expect(feed.profileReady).toBe(false);
    expect(match.factIds).toEqual([]);
    expect(match.reasons).toEqual(['Matches target role: DevOps engineer']);
    expect(JSON.stringify(feed.matches)).not.toMatch(/CV|approved profile/i);
    expect(feed.sources.find(source => source.id === postings[0]!.sourceId)?.activeJobCount).toBe(3);
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    await database.update(publicJobDiscoveryJobs).set({ firstSeenAt: stale, lastSeenAt: stale }).where(eq(publicJobDiscoveryJobs.id, match.job.id));
    expect((await getDiscoveryFeed(userId, database)).matches).not.toContainEqual(match);
    await expect(saveDiscoveredJob(userId, match.job.id, database)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('matches a target when any meaningful title term overlaps, and needs every broad term otherwise', async () => {
    const userId = await candidate();
    await database.update(users).set({ targetRoles: ['Product manager'] }).where(eq(users.id, userId));
    const fixture = (title: string): PublicDiscoveryJob => ({
      sourceId: DISCOVERY_SOURCES[0]!.id, provider: 'greenhouse', externalId: randomUUID(),
      title, company: 'Figma', location: 'Remote', workMode: 'remote',
      url: `https://boards.greenhouse.io/figma/jobs/${randomUUID()}`,
      text: 'Build useful products with the team.', postedAt: null,
    });
    const sourceId = DISCOVERY_SOURCES[0]!.id;
    await refreshDiscoveryPool({ database, sourceIds: [sourceId], force: true,
      fetchBoard: async () => [fixture('Product designer'), fixture('Senior product manager')] });
    // Product is meaningful for the selected role; manager and designer are broad titles.
    expect((await getDiscoveryFeed(userId, database)).sources.find(source => source.id === sourceId)?.activeJobCount).toBe(2);
    expect((await getDiscoveryFeed(userId, database)).matches.map(match => match.job.title).sort()).toEqual(['Product designer', 'Senior product manager'].sort());
    await database.update(users).set({ targetRoles: ['UX designer'] }).where(eq(users.id, userId));
    await refreshDiscoveryPool({ database, sourceIds: [DISCOVERY_SOURCES[0]!.id], force: true,
      fetchBoard: async () => [fixture('Brand designer'), fixture('UX designer')] });
    expect((await getDiscoveryFeed(userId, database)).matches.map(match => match.job.title)).toEqual(['UX designer']);

    await database.update(users).set({ targetRoles: ['Senior manager'] }).where(eq(users.id, userId));
    await refreshDiscoveryPool({ database, sourceIds: [DISCOVERY_SOURCES[0]!.id], force: true,
      fetchBoard: async () => [fixture('Manager'), fixture('Senior manager')] });
    expect((await getDiscoveryFeed(userId, database)).matches.map(match => match.job.title)).toEqual(['Senior manager']);
  });

  it('keeps and matches a custom non-starter target by a meaningful title term', async () => {
    const userId = await candidate();
    await database.update(users).set({ targetRoles: ['Customer Success Manager'] }).where(eq(users.id, userId));
    const fixture: PublicDiscoveryJob = {
      sourceId: DISCOVERY_SOURCES[0]!.id,
      provider: 'greenhouse',
      externalId: randomUUID(),
      title: 'Customer Support Associate',
      company: 'Example Support',
      location: 'Remote',
      workMode: 'remote',
      url: `https://boards.greenhouse.io/example/jobs/${randomUUID()}`,
      text: 'Help customers resolve account questions.',
      postedAt: null,
    };
    await refreshDiscoveryPool({ database, sourceIds: [fixture.sourceId], force: true, fetchBoard: async () => [fixture] });
    const feed = await getDiscoveryFeed(userId, database);
    expect(feed.profileReady).toBe(false);
    expect(feed.matches.map(match => match.job.title)).toEqual(['Customer Support Associate']);
    expect(feed.matches[0]?.factIds).toEqual([]);
    expect(feed.matches[0]?.reasons).toEqual(['Matches target role: Customer Success Manager']);
  });

  it('makes a failed scheduled start visible without overwriting a running source', async () => {
    await getDiscoveryFeed(await candidate(), database);
    const [first] = DISCOVERY_SOURCES;
    await database.update(publicJobDiscoverySources).set({ status: 'running' }).where(eq(publicJobDiscoverySources.id, first.id));
    await recordDiscoveryStartFailure(database);
    const rows = await database.select().from(publicJobDiscoverySources);
    expect(rows.find(row => row.id === first.id)?.status).toBe('running');
    const [state] = await database.select().from(discoveryCollectionState);
    expect(state.datasetError).toBe('WORKFLOW_START_FAILED');
    expect(rows.every(row => row.errorCode !== 'WORKFLOW_START_FAILED')).toBe(true);
    await database.update(publicJobDiscoverySources).set({ status: 'idle', claimToken: null }).where(eq(publicJobDiscoverySources.id, first.id));
  });

  it('rejects feed and save for an account pending deletion', async () => {
    const userId = await candidate();
    await database.update(users).set({ deletionRequestedAt: new Date() }).where(eq(users.id, userId));
    await expect(getDiscoveryFeed(userId, database)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
    await expect(saveDiscoveredJob(userId, randomUUID(), database)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
  });
});
