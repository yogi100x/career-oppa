import { and, eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import type {
  FitReviewRequirement,
  FitScorecard,
} from '@career-workspace/contracts';
import {
  events,
  fitReviews,
  getDatabase,
  jobs,
  opportunities,
  profileFacts,
} from '@career-workspace/db';
import { calculateFitScore } from '../../../packages/core/src/fit-score';
import { expect, test } from './fixtures';
import { captureFullContentScreenshot } from './full-content-screenshot';

type Envelope<T> = { data?: T; error?: { message?: string } };

const requirement = (
  text: string,
  importance: FitReviewRequirement['importance'],
  status: FitReviewRequirement['status'],
  job_quote: string,
  fact_ids: string[] = [],
): FitReviewRequirement => ({ text, importance, status, job_quote, fact_ids });

async function expectReachableAboveActionBar(
  page: import('@playwright/test').Page,
  target: import('@playwright/test').Locator,
) {
  const actionBar = page
    .getByRole('button', { name: /Prepare this application/ })
    .locator('xpath=ancestor::footer');
  await target.scrollIntoViewIfNeeded();
  await expect.poll(async () => {
    const targetBox = await target.boundingBox();
    const actionBarBox = await actionBar.boundingBox();
    if (!targetBox || !actionBarBox) return false;
    const aboveBar = targetBox.y >= 0 && targetBox.y + targetBox.height <= actionBarBox.y;
    const notCovered = await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.bottom - Math.min(3, rect.height / 4);
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === element || element.contains(hit)));
    });
    return aboveBar && notCovered;
  }).toBe(true);
}

test('shows the stored fit score and its requirement points on desktop and phone', async ({ page }) => {
  test.setTimeout(60_000);
  const testDatabaseUrl = process.env.DATABASE_TEST_URL;
  if (!testDatabaseUrl || new URL(testDatabaseUrl).pathname !== '/career_workspace_test')
    throw new Error('Set DATABASE_TEST_URL to career_workspace_test.');
  process.env.DATABASE_URL = testDatabaseUrl;
  const database = getDatabase();

  let opportunityId: string | undefined;
  let jobId: string | undefined;
  let reviewId: string | undefined;
  let factId: string | undefined;
  let userId: string | undefined;
  const auditDirectory = resolve('docs/ux-audit');

  try {
    const meResponse = await page.request.get('/api/v1/me');
    expect(meResponse.ok()).toBeTruthy();
    const me = (await meResponse.json()) as Envelope<{ id: string }>;
    userId = me.data?.id;
    expect(userId).toBeTruthy();

    const factText = 'Built accessible TypeScript tools for student support.';
    const factResponse = await page.request.post('/api/v1/profile/facts', {
      data: { kind: 'experience', text: factText },
    });
    expect(factResponse.ok()).toBeTruthy();
    const fact = (await factResponse.json()) as Envelope<{ id: string }>;
    factId = fact.data?.id;
    expect(factId).toBeTruthy();
    const approvalResponse = await page.request.patch(`/api/v1/profile/facts/${factId}`, {
      data: { status: 'approved' },
    });
    expect(approvalResponse.ok()).toBeTruthy();

    const jobText =
      'Build accessible TypeScript tools for student support. Work with product designers, write reliable tests, and lead a team of four through product launches. Experience with public cloud operations is helpful. The role works with a small product team.';
    const roleResponse = await page.request.post('/api/v1/jobs', {
      data: {
        title: 'Product engineer',
        company: 'Northstar Labs',
        location: 'London',
        text: jobText,
      },
    });
    expect(roleResponse.ok()).toBeTruthy();
    const role = (await roleResponse.json()) as Envelope<{
      job: { id: string };
      opportunity: { id: string };
    }>;
    jobId = role.data?.job.id;
    opportunityId = role.data?.opportunity.id;
    expect(jobId).toBeTruthy();
    expect(opportunityId).toBeTruthy();

    const reviewRequirements = [
      requirement(
        'Accessible TypeScript tools',
        'essential',
        'met',
        'Build accessible TypeScript tools for student support.',
        [factId!],
      ),
      requirement(
        'Work with product designers',
        'essential',
        'unknown',
        'Work with product designers,',
      ),
      requirement(
        'Write reliable tests',
        'essential',
        'unknown',
        'write reliable tests,',
      ),
      requirement(
        'Public cloud operations',
        'desirable',
        'gap',
        'Experience with public cloud operations is helpful.',
      ),
    ];
    const scorecard = calculateFitScore({
      requirements: reviewRequirements,
      jobText,
      grounding: [true, false, false, false],
      evidenceTexts: [[factText], [], [], []],
      evidenceAvailable: true,
      jobTitle: 'Product engineer',
      targetRoles: ['Software engineer'],
    });
    expect(scorecard.score).toBe(3.9);
    expect(scorecard.band).toBe('stretch');
    expect(scorecard.capReason).toBe('mostly_unknown_essentials');
    const [review] = await database
      .insert(fitReviews)
      .values({
        userId: userId!,
        opportunityId: opportunityId!,
        verdict: 'Recorded review for browser regression coverage.',
        strengths: [{ text: 'Accessible TypeScript tools', fact_ids: [factId!] }],
        gaps: scorecard.gaps,
        unknowns: scorecard.requirements
          .filter((row) => row.status === 'unknown')
          .map((row) => row.text),
        requirements: reviewRequirements,
        scorecard: scorecard satisfies FitScorecard,
        promptVersion: 'fit-score.e2e.v1',
        model: 'recorded-fit-score-fixture',
      })
      .returning({ id: fitReviews.id });
    reviewId = review.id;

    // The authenticated endpoint confirms the UI will read the stored result.
    const storedResponse = await page.request.get(
      `/api/v1/opportunities/${opportunityId}/fit-review`,
    );
    expect(storedResponse.ok()).toBeTruthy();
    const stored = (await storedResponse.json()) as Envelope<
      Array<{ scorecard: FitScorecard }>
    >;
    expect(stored.data?.[0]?.scorecard).toMatchObject({
      score: 3.9,
      band: 'stretch',
      capReason: 'mostly_unknown_essentials',
      nextAction: scorecard.nextAction,
      requirements: scorecard.requirements,
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/workspace');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Roles' })
      .click();
    await expect(page.getByRole('heading', { name: 'My roles' })).toBeVisible();
    await expect(page.getByText('Stretch', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Open Product engineer at Northstar Labs' })
      .click();

    const scorecardView = page.getByRole('region', { name: 'Fit score' });
    await expect(scorecardView).toBeVisible();
    await expect(scorecardView).toContainText('3.9');
    await expect(scorecardView).toContainText('Stretch');
    await expect(scorecardView).toContainText(scorecard.nextAction);
    await scorecardView.getByText('Requirement evidence and score points').click();
    await expect(scorecardView).toContainText('essential · met · weight 3 · counted weight 3 · earned 3.43 points');
    await expect(scorecardView).toContainText('desirable · gap · weight 0.5 · counted weight 0.5 · earned 0.00 points');
    await expect(scorecardView).toContainText(factText);
    const lastRequirement = scorecard.requirements.at(-1)!;
    const lastRequirementItem = scorecardView
      .getByText(lastRequirement.text, { exact: true })
      .first()
      .locator('xpath=ancestor::li[1]');
    await expectReachableAboveActionBar(page, lastRequirementItem);
    await expectReachableAboveActionBar(
      page,
      scorecardView.getByText(scorecard.nextAction, { exact: false }),
    );
    await captureFullContentScreenshot(page, resolve(auditDirectory, 'fit-score-desktop.png'), {
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/workspace');
    await page
      .getByRole('navigation', { name: 'Phone navigation' })
      .getByRole('link', { name: 'Roles' })
      .click();
    await expect(page.getByRole('heading', { name: 'My roles' })).toBeVisible();
    await expect(page.getByText('Stretch', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Open Product engineer at Northstar Labs' })
      .click();
    const phoneScorecard = page.getByRole('region', { name: 'Fit score' });
    await expect(phoneScorecard).toBeVisible();
    await expect(phoneScorecard).toContainText('3.9');
    await expect(phoneScorecard).toContainText('Stretch');
    await expect(phoneScorecard).toContainText(scorecard.nextAction);
    await phoneScorecard.getByText('Requirement evidence and score points').click();
    await expect(phoneScorecard).toContainText('earned 3.43 points');
    const phoneLastRequirement = phoneScorecard
      .getByText(lastRequirement.text, { exact: true })
      .first()
      .locator('xpath=ancestor::li[1]');
    await expectReachableAboveActionBar(page, phoneLastRequirement);
    await expectReachableAboveActionBar(
      page,
      phoneScorecard.getByText(scorecard.nextAction, { exact: false }),
    );
    await captureFullContentScreenshot(page, resolve(auditDirectory, 'fit-score-phone.png'), {
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
  } finally {
    if (opportunityId && userId) {
      await database
        .delete(events)
        .where(and(
          eq(events.userId, userId),
          eq(events.subjectType, 'opportunity'),
          eq(events.subjectId, opportunityId),
        ));
    }
    if (factId && userId) {
      await database
        .delete(events)
        .where(and(
          eq(events.userId, userId),
          eq(events.subjectType, 'profile_fact'),
          eq(events.subjectId, factId),
        ));
    }
    if (reviewId)
      await database.delete(fitReviews).where(eq(fitReviews.id, reviewId));
    if (opportunityId)
      await database
        .delete(opportunities)
        .where(eq(opportunities.id, opportunityId));
    if (jobId) await database.delete(jobs).where(eq(jobs.id, jobId));
    if (factId)
      await database.delete(profileFacts).where(eq(profileFacts.id, factId));
  }
});
