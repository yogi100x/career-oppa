import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  coachMessages,
  createDatabase,
  opportunities,
  profileFacts,
  publicJobDiscoveryJobs,
  publicJobDiscoverySources,
  tasks,
  users,
} from '@career-workspace/db';
import type { streamCoach } from '@career-workspace/adapters/ai/coach';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTelegramCoach } from './telegram-coach';
import { confirmCoachSaveProposal, discoveryMatches, proposeDiscoveredJob } from './coach-toolset';
import type { TelegramUpdate } from './telegram-types';
import { handleTelegramCommand } from './telegram-commands';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;
const TOOL_KEYS = [
  'discoveryMatches',
  'profile',
  'proposeStatus',
  'reminders',
  'role',
  'roles',
  'saveDiscoveredJob',
];
const FEATURE_TOKEN = 'Coachqzx';

integration('shared coach toolset with job discovery', () => {
  const { database, pool } = createDatabase(databaseUrl!);
  const userTag = randomUUID();
  const clerkIdA = `coach-tools-a-${userTag}`;
  const clerkIdB = `coach-tools-b-${userTag}`;
  const jobIds: string[] = [];
  let userAId: string;
  let userBId: string;
  let factId: string;
  const sourceId = 'greenhouse:figma';
  let featureWasSet: string | undefined;

  async function addJob(label: string) {
    const url = `https://boards.greenhouse.io/figma/jobs/${randomUUID()}`;
    const [job] = await database
      .insert(publicJobDiscoveryJobs)
      .values({
        sourceId,
        externalId: randomUUID(),
        canonicalUrl: url,
        canonicalUrlHash: createHash('sha256').update(url).digest('hex'),
        title: `${FEATURE_TOKEN} TypeScript Engineer ${label}`,
        company: 'Coach Test Company',
        location: 'Remote',
        workMode: 'remote',
        url,
        text: `${FEATURE_TOKEN} builds TypeScript products with a collaborative engineering team and reliable systems. The role contributes to maintainable services with product teams and supports customers across a stable platform.`,
        postedAt: null,
        active: true,
      })
      .returning({ id: publicJobDiscoveryJobs.id });
    jobIds.push(job.id);
    return job.id;
  }

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    featureWasSet = process.env.FEATURE_DISCOVERY;
    vi.stubEnv('FEATURE_DISCOVERY', 'true');
    const [source] = await database
      .insert(publicJobDiscoverySources)
      .values({ id: sourceId, provider: 'greenhouse', board: 'figma', company: 'Figma' })
      .onConflictDoNothing()
      .returning({ id: publicJobDiscoverySources.id });
    void source;
    const createdUsers = await database
      .insert(users)
      .values([
        { clerkId: clerkIdA, targetRoles: [] },
        { clerkId: clerkIdB, targetRoles: [] },
      ])
      .returning({ id: users.id });
    [userAId, userBId] = createdUsers.map(({ id }) => id);
    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId: userAId,
        kind: 'skill',
        text: `${FEATURE_TOKEN} TypeScript engineer`,
        source: 'user',
        status: 'approved',
      })
      .returning({ id: profileFacts.id });
    factId = fact.id;
    for (let index = 1; index <= 12; index++) await addJob(`Listing${index}`);
  });

  afterAll(async () => {
    if (jobIds.length)
      await database
        .delete(publicJobDiscoveryJobs)
        .where(inArray(publicJobDiscoveryJobs.id, jobIds));
    if (userAId || userBId)
      await database
        .delete(users)
        .where(inArray(users.id, [userAId, userBId].filter(Boolean)));
    vi.unstubAllEnvs();
    if (featureWasSet !== undefined) process.env.FEATURE_DISCOVERY = featureWasSet;
    await pool.end();
  });

  beforeEach(() => {
    vi.stubEnv('FEATURE_DISCOVERY', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('filters the caller’s approved CV matches and caps the result at ten', async () => {
    const result = await discoveryMatches(userAId, FEATURE_TOKEN, database);
    expect(result.matches).toHaveLength(10);
    expect(result.matches.every((match) => match.title.includes(FEATURE_TOKEN))).toBe(true);
    expect(result.matches.every((match) => match.url.startsWith('https://boards.greenhouse.io/'))).toBe(true);
    expect((await discoveryMatches(userAId, 'NoSuchRole', database)).matches).toEqual([]);
  });

  it('only returns matches for users whose own approved facts match, with a clear empty result', async () => {
    const own = await discoveryMatches(userAId, FEATURE_TOKEN, database);
    const other = await discoveryMatches(userBId, FEATURE_TOKEN, database);
    expect(own.matches.length).toBeGreaterThan(0);
    expect(other.matches).toEqual([]);
    expect(other.message).toBe('No matches collected yet. Open Discover on the web to refresh.');
    const facts = await database.select({ id: profileFacts.id }).from(profileFacts).where(eq(profileFacts.userId, userAId));
    expect(facts.map(({ id }) => id)).toContain(factId);
  });

  it('creates a save proposal without writing a role and rejects confirmation by another user', async () => {
    const discoveredJobId = jobIds[0]!;
    const before = await database.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.userId, userAId));
    const proposal = await proposeDiscoveredJob(userAId, discoveredJobId, database);
    const after = await database.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.userId, userAId));
    expect(after).toHaveLength(before.length);
    expect(proposal).toMatchObject({ kind: 'save_discovered_job', opportunityId: null, confirmedAt: null });
    await expect(confirmCoachSaveProposal(userBId, proposal.id, database)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await database.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.userId, userBId))).toHaveLength(0);
  });

  it('locks concurrent and repeated confirmations so the discovered role is saved once', async () => {
    const discoveredJobId = jobIds[1]!;
    const proposal = await proposeDiscoveredJob(userAId, discoveredJobId, database);
    const [first, second] = await Promise.all([
      confirmCoachSaveProposal(userAId, proposal.id, database),
      confirmCoachSaveProposal(userAId, proposal.id, database),
    ]);
    const replay = await confirmCoachSaveProposal(userAId, proposal.id, database);
    expect(new Set([first.opportunity.id, second.opportunity.id, replay.opportunity.id]).size).toBe(1);
    expect([first, second].filter((item) => !item.alreadyConfirmed)).toHaveLength(1);
    expect(replay.alreadyConfirmed).toBe(true);
    const roles = await database.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.userId, userAId));
    expect(roles.filter(({ id }) => id === replay.opportunity.id)).toHaveLength(1);
  });

  it('rejects missing matches and proposals for jobs that have since closed', async () => {
    await expect(proposeDiscoveredJob(userAId, randomUUID(), database)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const discoveredJobId = await addJob('ClosingSoon');
    const proposal = await proposeDiscoveredJob(userAId, discoveredJobId, database);
    await database.update(publicJobDiscoveryJobs).set({ active: false }).where(eq(publicJobDiscoveryJobs.id, discoveredJobId));
    await expect(confirmCoachSaveProposal(userAId, proposal.id, database)).rejects.toMatchObject({ status: 409, code: 'MATCH_UNAVAILABLE' });
  });

  it('gives Telegram the real shared seven-tool set and lists no more than five collected jobs per reply', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const update: TelegramUpdate = { updateId: 781_010_001, text: `Find ${FEATURE_TOKEN} jobs`, chatId: `coach-tools-${userTag}`, telegramUserId: `coach-tools-${userTag}` };
    let toolKeys: string[] = [];
    let collected: Array<{ title: string; company: string; url: string }> = [];
    const recordedStream: typeof streamCoach = async (options) => {
      toolKeys = Object.keys(options.tools).sort();
      const result = await options.tools.discoveryMatches(FEATURE_TOKEN) as { matches: typeof collected };
      collected = result.matches;
      await options.onFinish('Recorded reply used only by this test.', { model: 'recorded-test', promptVersion: 'test' });
      return { toTextStreamResponse: () => new Response('Recorded reply used only by this test.') };
    };
    const replies = await handleTelegramCoach(userAId, update, { database, stream: recordedStream });
    expect(toolKeys).toEqual(TOOL_KEYS);
    expect(replies).toHaveLength(2);
    expect(replies.every(({ text }) => text.length < 3000)).toBe(true);
    for (const reply of replies) {
      const listed = reply.text.match(/Coach Test Company/g) ?? [];
      expect(listed.length).toBeLessThanOrEqual(5);
      expect(listed.length).toBeGreaterThan(0);
    }
    expect(collected).toHaveLength(10);
    for (const match of collected) {
      expect(replies.map(({ text }) => text).join('\n')).toContain(match.title);
      expect(replies.map(({ text }) => text).join('\n')).toContain(match.company);
      expect(replies.map(({ text }) => text).join('\n')).toContain(match.url);
    }
  });

  it('keeps the save button and replies on cached Telegram retries, then saves once for the owner', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const discoveredJobId = jobIds[2]!;
    const update: TelegramUpdate = { updateId: 781_010_002, text: 'Save that job', chatId: `coach-tools-${userTag}`, telegramUserId: `coach-tools-${userTag}` };
    let toolKeys: string[] = [];
    let toolProposalId = '';
    let calls = 0;
    const recordedStream: typeof streamCoach = async (options) => {
      calls++;
      toolKeys = Object.keys(options.tools).sort();
      const proposal = await options.tools.saveDiscoveredJob(discoveredJobId) as { id: string };
      toolProposalId = proposal.id;
      await options.onFinish('Recorded reply used only by this test.', { model: 'recorded-test', promptVersion: 'test' });
      return { toTextStreamResponse: () => new Response('Recorded reply used only by this test.') };
    };
    const first = await handleTelegramCoach(userAId, update, { database, stream: recordedStream });
    const retry = await handleTelegramCoach(userAId, update, { database, stream: recordedStream });
    expect(toolKeys).toEqual(TOOL_KEYS);
    expect(calls).toBe(1);
    expect(retry).toEqual(first);
    const saveButton = first.flatMap(({ buttons }) => buttons ?? []).find(({ data }) => data?.startsWith('s:'));
    expect(saveButton).toMatchObject({ text: 'Save this role', data: `s:${toolProposalId}` });
    expect(Buffer.byteLength(saveButton!.data!, 'utf8')).toBeLessThan(64);
    const before = await database.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.userId, userAId));
    const callback: TelegramUpdate = { ...update, updateId: 781_010_003, text: '', callbackData: saveButton!.data };
    await handleTelegramCommand(userAId, callback, { database, appUrl: 'https://career.example.test' });
    await handleTelegramCommand(userAId, { ...callback, updateId: 781_010_004 }, { database, appUrl: 'https://career.example.test' });
    const after = await database.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.userId, userAId));
    expect(after).toHaveLength(before.length + 1);
    const [savedProposal] = await database.select().from(tasks).where(and(eq(tasks.id, toolProposalId), eq(tasks.userId, userAId)));
    expect(savedProposal?.status).toBe('succeeded');
    const [message] = await database.select().from(coachMessages).where(and(eq(coachMessages.userId, userAId), eq(coachMessages.requestKey, `telegram:${update.updateId}`), eq(coachMessages.role, 'user')));
    expect(message?.status).toBe('completed');
  });
});
