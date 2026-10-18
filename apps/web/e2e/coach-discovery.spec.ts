import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  getDatabase,
  coachMessages,
  jobs,
  opportunities,
  profileFacts,
  publicJobDiscoveryJobs,
  publicJobDiscoverySources,
  tasks,
} from '@career-workspace/db';
import { expect, test } from './fixtures';

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
type RoleRow = { job: { title: string; company: string } };
const EMPTY_DISCOVERY_REPLY =
  'No matches collected yet. Open Discover on the web to refresh.';

test('a collected discovery save stays a proposal until confirmed in the coach', async (
  { page },
  testInfo,
) => {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  ) {
    throw new Error('Coach browser fixtures require career_workspace_test.');
  }
  process.env.DATABASE_URL = databaseUrl;
  const database = getDatabase();
  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.ok()).toBeTruthy();
  const me = (await meResponse.json()) as Envelope<{ id: string }>;
  const userId = me.data?.id;
  expect(userId).toBeTruthy();

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const skill = `coachmatch${suffix}`;
  const title = `Coach discovery ${suffix} Platform Engineer`;
  const company = `Recorded discovery company ${suffix}`;
  const url = `https://boards.greenhouse.io/figma/jobs/${suffix}`;
  const canonicalUrlHash = createHash('sha256').update(url).digest('hex');
  const anchorTitle = `Coach scope anchor ${suffix}`;
  const anchorResponse = await page.request.post('/api/v1/jobs', {
    data: {
      title: anchorTitle,
      company: `Coach fixture ${suffix}`,
      text: 'An unrelated saved role used to open the role-scoped coach panel. '.repeat(
        3,
      ),
    },
  });
  expect(anchorResponse.ok()).toBeTruthy();
  const anchor = (await anchorResponse.json()) as Envelope<{
    job: { id: string };
    opportunity: { id: string };
  }>;
  const anchorJobId = anchor.data?.job.id;
  const anchorOpportunityId = anchor.data?.opportunity.id;
  expect(anchorJobId).toBeTruthy();
  expect(anchorOpportunityId).toBeTruthy();

  const [fact] = await database
    .insert(profileFacts)
    .values({
      userId: userId!,
      kind: 'skill',
      text: `Approved recorded browser fixture skill ${skill}.`,
      source: 'user',
      status: 'approved',
    })
    .returning();
  await database
    .insert(publicJobDiscoverySources)
    .values({
      id: 'greenhouse:figma',
      provider: 'greenhouse',
      board: 'figma',
      company: 'Figma',
    })
    .onConflictDoNothing();
  const [discoveredJob] = await database
    .insert(publicJobDiscoveryJobs)
    .values({
      sourceId: 'greenhouse:figma',
      externalId: `browser-fixture-${suffix}`,
      canonicalUrl: url,
      canonicalUrlHash,
      title,
      company,
      location: 'Remote worldwide',
      workMode: 'remote',
      url,
      text: `This platform engineering role asks for experience with ${skill}, thoughtful software delivery, reliable services, and clear communication with the engineering team.`,
    })
    .returning();
  const [proposal] = await database
    .insert(tasks)
    .values({
      userId: userId!,
      kind: 'coach_save_discovery',
      input: {
        discoveredJobId: discoveredJob.id,
        title,
        company,
        url,
      },
      idempotencyKey: `coach-save-browser-fixture:${userId}:${suffix}`,
    })
    .returning();
  const [userMessage] = await database
    .insert(coachMessages)
    .values({
      userId: userId!,
      role: 'user',
      content: EMPTY_DISCOVERY_REPLY,
      status: 'completed',
      requestKey: `coach-discovery-user-fixture:${suffix}`,
    })
    .returning();

  let savedOpportunityId: string | undefined;
  let assistantMessageId: string | undefined;
  try {
    const rolesBeforeResponse = await page.request.get('/api/v1/opportunities');
    expect(rolesBeforeResponse.ok()).toBeTruthy();
    const rolesBefore = (await rolesBeforeResponse.json()) as Envelope<
      RoleRow[]
    >;
    expect(rolesBefore.data?.some((row) => row.job.title === title)).toBe(false);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/workspace/roles/${anchorOpportunityId}`);
    await expect(page.getByRole('heading', { name: anchorTitle })).toBeVisible();
    await page.getByRole('button', { name: 'Talk to Oppa' }).click();
    await expect(page.getByText(EMPTY_DISCOVERY_REPLY)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Discover' })).toHaveCount(
      0,
    );
    const [assistantMessage] = await database
      .insert(coachMessages)
      .values({
        userId: userId!,
        role: 'assistant',
        content: EMPTY_DISCOVERY_REPLY,
        status: 'completed',
        replyToId: userMessage.id,
        promptVersion: 'recorded-browser-fixture.v1',
        model: 'recorded-browser-fixture',
      })
      .returning();
    assistantMessageId = assistantMessage.id;
    await page.reload();
    await page.getByRole('button', { name: 'Talk to Oppa' }).click();
    await expect(page.getByRole('link', { name: 'Open Discover' })).toHaveAttribute(
      'href',
      '/workspace/discover',
    );
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText(company)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save this role' })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('coach-discovery-proposal-desktop.png'),
      fullPage: true,
    });

    const confirmResponseWait = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/v1/coach/proposals/${proposal.id}/confirm`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save this role' }).click();
    const confirmResponse = await confirmResponseWait;
    expect(confirmResponse.ok()).toBeTruthy();
    const confirmed = (await confirmResponse.json()) as Envelope<{
      proposal: { confirmedAt: string | null };
      opportunity: { id: string; jobId?: string };
      alreadyConfirmed: boolean;
    }>;
    expect(confirmed.data).toMatchObject({
      proposal: { confirmedAt: expect.any(String) },
      alreadyConfirmed: false,
    });
    savedOpportunityId = confirmed.data?.opportunity.id;
    await expect(page.getByText('Role saved.')).toBeVisible();

    const rolesAfterResponse = await page.request.get('/api/v1/opportunities');
    expect(rolesAfterResponse.ok()).toBeTruthy();
    const rolesAfter = (await rolesAfterResponse.json()) as Envelope<RoleRow[]>;
    expect(rolesAfter.data?.filter((row) => row.job.title === title)).toHaveLength(
      1,
    );
    const idempotentResponse = await page.request.post(
      `/api/v1/coach/proposals/${proposal.id}/confirm`,
      { data: { confirmed: true } },
    );
    expect(idempotentResponse.ok()).toBeTruthy();
    const idempotent = (await idempotentResponse.json()) as Envelope<{
      opportunity: { id: string };
      alreadyConfirmed: boolean;
    }>;
    expect(idempotent.data).toMatchObject({
      opportunity: { id: savedOpportunityId },
      alreadyConfirmed: true,
    });
    const rolesAfterReplayResponse = await page.request.get(
      '/api/v1/opportunities',
    );
    const rolesAfterReplay = (await rolesAfterReplayResponse.json()) as Envelope<
      RoleRow[]
    >;
    expect(
      rolesAfterReplay.data?.filter((row) => row.job.title === title),
    ).toHaveLength(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText('Role saved.')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('coach-discovery-saved-phone.png'),
      fullPage: true,
    });
  } finally {
    if (savedOpportunityId) {
      const [savedRole] = await database
        .select({ jobId: opportunities.jobId })
        .from(opportunities)
        .where(eq(opportunities.id, savedOpportunityId));
      await database
        .delete(opportunities)
        .where(eq(opportunities.id, savedOpportunityId));
      if (savedRole?.jobId) {
        await database.delete(jobs).where(eq(jobs.id, savedRole.jobId));
      }
    }
    if (assistantMessageId) {
      await database
        .delete(coachMessages)
        .where(eq(coachMessages.id, assistantMessageId));
    }
    await database
      .delete(coachMessages)
      .where(eq(coachMessages.id, userMessage.id));
    await database.delete(tasks).where(eq(tasks.id, proposal.id));
    await database
      .delete(publicJobDiscoveryJobs)
      .where(eq(publicJobDiscoveryJobs.id, discoveredJob.id));
    await database.delete(profileFacts).where(eq(profileFacts.id, fact.id));
    if (anchorOpportunityId) {
      await database
        .delete(opportunities)
        .where(eq(opportunities.id, anchorOpportunityId));
    }
    if (anchorJobId) await database.delete(jobs).where(eq(jobs.id, anchorJobId));
  }
});
