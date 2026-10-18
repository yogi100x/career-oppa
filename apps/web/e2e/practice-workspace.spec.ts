import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test } from './fixtures';
import { getDatabase, practiceSessions } from '@career-workspace/db';
import { jobs } from '../../../packages/db/src/roles-schema';

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

test('practice keeps answers when AI is unavailable and displays saved feedback', async ({ page }, testInfo) => {
  const testUrl = process.env.DATABASE_TEST_URL;
  if (!testUrl || new URL(testUrl).pathname.slice(1) !== 'career_workspace_test')
    throw new Error('Set DATABASE_TEST_URL to the isolated career_workspace_test database.');
  process.env.DATABASE_URL = testUrl;
  const database = getDatabase();
  const marker = randomUUID();
  const jobIds: string[] = [];
  const opportunityIds: string[] = [];
  const sessionIds: string[] = [];

  const addRole = async (title: string) => {
    const response = await page.request.post('/api/v1/jobs', {
      data: {
        title: `${title} ${marker}`,
        company: 'Practice browser fixture',
        text: 'Work with a team to plan, build, test, and communicate useful software. '.repeat(3),
      },
    });
    expect(response.ok()).toBeTruthy();
    const data = (await response.json()) as Envelope<{ opportunity: { id: string }; job: { id: string } }>;
    expect(data.data).toBeTruthy();
    jobIds.push(data.data!.job.id);
    opportunityIds.push(data.data!.opportunity.id);
    return data.data!.opportunity.id;
  };

  try {
    const meResponse = await page.request.get('/api/v1/me');
    expect(meResponse.ok()).toBeTruthy();
    const userId = ((await meResponse.json()) as Envelope<{ id: string }>).data?.id;
    expect(userId).toBeTruthy();
    const firstOpportunityId = await addRole('Practice readiness role');
    const readyQuestions = [
      { question: 'Tell me about a project you are proud of.', focus: 'Your part and result' },
      { question: 'How do you handle a difficult deadline?', focus: 'Your steps and communication' },
      { question: 'What would you like to learn here?', focus: 'A realistic growth goal' },
    ];
    const [readySession] = await database.insert(practiceSessions).values({
      userId: userId!,
      opportunityId: firstOpportunityId,
      questions: readyQuestions,
      answers: [],
      status: 'questions_ready',
      questionPromptVersion: 'browser-fixture.v1',
      model: 'recorded-fixture',
    }).returning({ id: practiceSessions.id });
    sessionIds.push(readySession.id);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/workspace/roles/${firstOpportunityId}/practice`);
    await expect(page.getByRole('heading', { name: 'Practice your interview' })).toBeVisible();
    await expect(page.getByText('One session costs 3 credits. Feedback is included. Your answers stay private to your account.')).toBeVisible();
    const answerTexts = [
      `I planned and tested a useful release ${marker}.`,
      `I split the work, shared risks early, and tested the key path ${marker}.`,
      `I want to learn more about accessible product design ${marker}.`,
    ];
    for (const [index, answer] of answerTexts.entries())
      await page.locator('textarea').nth(index).fill(answer);
    await page.screenshot({ path: 'output/practice-answers-desktop.png', fullPage: true });
    await page.getByLabel('I wrote these answers from my own experience and am ready to receive feedback.').check();
    await page.getByRole('button', { name: 'Get feedback' }).click();
    await expect(page.getByText(/Your credits were not charged\./)).toBeVisible();
    const savedReady = await database.select().from(practiceSessions).where(eq(practiceSessions.id, readySession.id));
    expect(savedReady[0]).toMatchObject({ status: 'questions_ready', answers: [], feedback: null });
    for (const [index, answer] of answerTexts.entries())
      await expect(page.locator('textarea').nth(index)).toHaveValue(answer);

    const secondOpportunityId = await addRole('Practice feedback role');
    const completedFeedback = {
      overall: `Your examples are clear and specific ${marker}.`,
      strengths: ['You described your own contribution.'],
      improvements: ['Add one measurable result.'],
      nextSteps: ['Practice a shorter opening.'],
    };
    const [completedSession] = await database.insert(practiceSessions).values({
      userId: userId!,
      opportunityId: secondOpportunityId,
      questions: readyQuestions,
      answers: answerTexts,
      feedback: completedFeedback,
      status: 'completed',
      questionPromptVersion: 'browser-fixture.v1',
      feedbackPromptVersion: 'browser-fixture.v1',
      model: 'recorded-fixture',
    }).returning({ id: practiceSessions.id });
    sessionIds.push(completedSession.id);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/workspace/roles/${secondOpportunityId}/practice`);
    await expect(page.getByText(completedFeedback.overall)).toBeVisible();
    await expect(page.getByText('This feedback is a practice aid, not a hiring prediction.')).toBeVisible();
    await page.screenshot({ path: 'output/practice-feedback-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'output/practice-feedback-phone.png', fullPage: true });
    await expect(page.getByRole('heading', { name: 'What worked' })).toBeVisible();
  } finally {
    if (sessionIds.length)
      await database.delete(practiceSessions).where(eq(practiceSessions.id, sessionIds[0]!));
    for (const sessionId of sessionIds.slice(1))
      await database.delete(practiceSessions).where(eq(practiceSessions.id, sessionId));
    for (const jobId of jobIds)
      await database.delete(jobs).where(eq(jobs.id, jobId));
  }
  expect(testInfo.project.name).toBe('chromium');
});
