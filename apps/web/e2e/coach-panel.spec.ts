import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import { coachProposals, getDatabase } from '@career-workspace/db';
import { eq } from 'drizzle-orm';

type Envelope<T> = { data?: T; error?: { message?: string } };

test('shows missing AI setup and requires explicit confirmation for coach status changes', async ({
  page,
}, testInfo) => {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  ) {
    throw new Error('Coach browser fixtures require career_workspace_test.');
  }
  process.env.DATABASE_URL = databaseUrl;

  const userResponse = await page.request.get('/api/v1/me');
  expect(userResponse.ok()).toBeTruthy();
  const userEnvelope = (await userResponse.json()) as Envelope<{ id: string }>;
  const userId = userEnvelope.data?.id;
  expect(userId).toBeTruthy();

  const fixtureResponse = await page.request.post('/api/v1/jobs', {
    data: {
      title: `Coach fixture ${randomUUID().slice(0, 8)}`,
      company: 'Test company',
      text: 'A saved role fixture for checking coach suggestions and explicit status confirmation. '.repeat(
        4,
      ),
    },
  });
  expect(fixtureResponse.status()).toBe(200);
  const fixtureBody = (await fixtureResponse.json()) as Envelope<{
    opportunity: { id: string };
  }>;
  const opportunityId = fixtureBody.data?.opportunity.id;
  expect(opportunityId).toBeTruthy();
  const database = getDatabase();
  const [proposal] = await database
    .insert(coachProposals)
    .values({
      userId: userId!,
      opportunityId: opportunityId!,
      data: {
        from: 'saved',
        to: 'reviewed',
        reason:
          'You have looked over the role and are ready to consider an application.',
      },
    })
    .returning();

  await page.goto('/workspace/coach');
  await expect(page.getByRole('heading', { name: 'Your coach' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Saved to Reviewed' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'You have looked over the role and are ready to consider an application.',
    ),
  ).toBeVisible();

  await page.getByLabel('Talk it through').fill('What should I do next?');
  const chatResponseWait = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/coach/chat') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Send' }).click();
  const chatResponse = await chatResponseWait;
  expect(chatResponse.status()).toBe(503);
  await expect(
    page.getByText('Your coach is not connected to AI yet.'),
  ).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath('coach-desktop.png'),
    fullPage: true,
  });
  await expect(page.getByText('Current status: Saved')).toBeVisible();
  const initialTimeline = await page.request.get(
    `/api/v1/opportunities/${opportunityId}/timeline`,
  );
  expect(initialTimeline.ok()).toBeTruthy();
  const initialTimelineBody = (await initialTimeline.json()) as Envelope<{
    timeline: { type: string }[];
  }>;
  expect(
    initialTimelineBody.data?.timeline.filter(
      (event) => event.type === 'opportunity.status_changed',
    ),
  ).toHaveLength(0);

  await page.getByRole('button', { name: 'Confirm Reviewed' }).click();
  await expect(page.getByText('Current status: Reviewed')).toBeVisible();
  await expect(page.getByText('Status change confirmed.')).toBeVisible();
  const timelineResponse = await page.request.get(
    `/api/v1/opportunities/${opportunityId}/timeline`,
  );
  const timelineBody = (await timelineResponse.json()) as Envelope<{
    timeline: { type: string }[];
  }>;
  expect(
    timelineBody.data?.timeline.filter(
      (event) => event.type === 'opportunity.status_changed',
    ),
  ).toHaveLength(1);
  const [proposalRow] = await database
    .select()
    .from(coachProposals)
    .where(eq(coachProposals.id, proposal.id));
  expect(proposalRow?.confirmedAt).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/workspace/coach');
  await expect(
    page.getByRole('heading', { name: 'Saved to Reviewed' }),
  ).toBeVisible();
  await expect(page.getByText('Status change confirmed.')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('coach-phone.png'),
    fullPage: true,
  });
});
