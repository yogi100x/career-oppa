import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import {
  createDatabase,
  profileFacts,
  publicJobDiscoveryJobs,
  publicJobDiscoverySources,
  users,
} from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance } from './credits';
import { coachReaders } from './coach';
import { getDiscoveryFeed } from './discovery';
import { createFitReview, getFitReviews } from './fit-review';
import { createJob, canonicalJobUrl } from './roles';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('fit score persistence and shared readers', () => {
  const { database, pool } = createDatabase(databaseUrl!);
  let userId: string;
  let otherUserId: string;
  let factId: string;
  let opportunityId: string;
  let sourceId: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');

    const [owner, other] = await database.insert(users).values([
      { clerkId: `fit-score-${randomUUID()}`, targetRoles: ['Software Engineer'] },
      { clerkId: `fit-score-other-${randomUUID()}` },
    ]).returning({ id: users.id });
    userId = owner.id;
    otherUserId = other.id;

    const [fact] = await database.insert(profileFacts).values({
      userId,
      kind: 'skill',
      text: 'Built production TypeScript applications',
      source: 'user',
      status: 'approved',
    }).returning({ id: profileFacts.id });
    factId = fact.id;

    const url = `https://boards.greenhouse.io/example/jobs/${randomUUID()}`;
    sourceId = `greenhouse:fit-score-${randomUUID()}`;
    const canonicalUrl = canonicalJobUrl(url);
    await database.insert(publicJobDiscoverySources).values({
      id: sourceId,
      provider: 'greenhouse',
      board: 'example',
      company: 'Example',
      catalogActive: true,
    });
    const text = [
      'We are hiring a Software Engineer to build TypeScript applications and reliable web services.',
      'The role requires production TypeScript experience and clear communication with product teams.',
      'Salary range £60,000–£80,000. Remote-first team with collaborative culture.',
    ].join(' ');
    await database.insert(publicJobDiscoveryJobs).values({
      sourceId,
      externalId: randomUUID(),
      canonicalUrl,
      canonicalUrlHash: createHash('sha256').update(canonicalUrl).digest('hex'),
      title: 'Software Engineer',
      company: 'Example',
      location: 'Remote',
      workMode: 'remote',
      url,
      text,
    });

    const feed = await getDiscoveryFeed(userId, database);
    const match = feed.matches.find((row) => row.job.url === url);
    expect(match).toBeDefined();
    const saved = await createJob(userId, {
      title: match!.job.title,
      company: match!.job.company,
      location: match!.job.location,
      url: match!.job.url,
      text: match!.job.text,
    }, { database });
    opportunityId = saved.opportunity.id;
  });

  afterAll(async () => {
    if (userId && otherUserId)
      await database.delete(users).where(eq(users.id, userId));
    if (otherUserId)
      await database.delete(users).where(eq(users.id, otherUserId));
    if (sourceId) {
      await database.delete(publicJobDiscoveryJobs).where(eq(publicJobDiscoveryJobs.sourceId, sourceId));
      await database.delete(publicJobDiscoverySources).where(eq(publicJobDiscoverySources.id, sourceId));
    }
    await pool.end();
  });

  it('persists one grounded scorecard for fit review, coach, roles, and discovery', async () => {
    const generator = createRecordedResponseGenerator({
      'fit-review.v5': {
        verdict: 'There is evidence for the main TypeScript requirement.',
        requirements: [
          {
            text: 'Production TypeScript experience',
            importance: 'essential',
            status: 'met',
            fact_ids: [factId],
            job_quote: 'production TypeScript experience',
          },
          {
            text: 'Communicates clearly',
            importance: 'essential',
            status: 'met',
            fact_ids: [randomUUID()],
            job_quote: 'clear communication with product teams',
          },
          {
            text: 'Has a PhD',
            importance: 'essential',
            status: 'met',
            fact_ids: [],
            job_quote: 'must have a PhD',
          },
        ],
      },
    });
    let calls = 0;
    const before = await balance(userId, { database });
    const first = await createFitReview(userId, opportunityId, 'score-persistence', {
      database,
      generate: async (prompt, schema, input) => {
        calls += 1;
        return generator(prompt, schema, input);
      },
    });
    const afterFirst = await balance(userId, { database });
    const replay = await createFitReview(userId, opportunityId, 'score-persistence', {
      database,
      generate: generator,
    });
    const afterReplay = await balance(userId, { database });
    const reviews = await getFitReviews(userId, opportunityId, database);
    const roleReader = coachReaders(userId, database);
    const coachRole = await roleReader.role(opportunityId);
    const roles = await roleReader.roles();
    const feed = await getDiscoveryFeed(userId, database);
    const discoveryMatch = feed.matches.find((match) => match.savedOpportunityId === opportunityId);

    expect(first.isFree).toBe(true);
    expect(first.id).toBe(replay.id);
    expect(calls).toBe(1);
    expect(afterFirst.available).toBe(before.available);
    expect(afterReplay.available).toBe(afterFirst.available);
    expect(first.scorecard).toMatchObject({
      band: 'strong_fit',
      factors: { cvMatch: { met: 1, total: 2 } },
    });
    expect(first.scorecard?.score).toBe(5);
    expect(first.scorecard?.confidence).not.toBe('high');
    expect(first.requirements).toEqual([
      expect.objectContaining({ status: 'met', fact_ids: [factId] }),
      expect.objectContaining({ status: 'unknown', fact_ids: [] }),
    ]);
    expect(first.requirements?.some((requirement) => requirement.text === 'Has a PhD')).toBe(false);
    expect(reviews[0]).toMatchObject({
      scorecard: first.scorecard,
      requirements: first.requirements,
    });
    expect(coachRole.fitReview).toMatchObject({
      scorecard: first.scorecard,
      requirements: first.requirements,
    });
    await expect(coachReaders(otherUserId, database).role(opportunityId))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(roles.find((role) => role.id === opportunityId)?.fitBand).toBe(first.scorecard?.band);
    expect(discoveryMatch?.fitBand).toBe(first.scorecard?.band);
  });
});
