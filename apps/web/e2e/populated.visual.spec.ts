import { and, eq } from 'drizzle-orm';
import { expect, test } from './fixtures';
import {
  checkRoleReviewScroll,
  expectFullContentScreenshot,
} from './full-content-screenshot';
import {
  companies,
  contacts,
  events,
  fitReviews,
  getDatabase,
  jobs,
  ledgerEntries,
  outreachDrafts,
  opportunities,
  profileFacts,
  practiceSessions,
  posts,
  projects,
  rewardSubmissions,
  resumeVersions,
  users,
} from '@career-workspace/db';
import type { FitScorecard } from '@career-workspace/contracts';
import { createHash, randomUUID } from 'node:crypto';

type Envelope<T> = {
  data?: T;
  error?: { code?: string; message?: string };
};

async function expectNoHorizontalOverflow(
  page: import('@playwright/test').Page,
  width: number,
) {
  const measured = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(measured.viewport).toBe(width);
  expect(measured.document).toBeLessThanOrEqual(width);
  expect(measured.body).toBeLessThanOrEqual(width);
}

async function settlePageForScreenshot(
  page: import('@playwright/test').Page,
  options: { requireClerk?: boolean; requireUserButton?: boolean } = {},
) {
  if (options.requireClerk !== false) {
    await page.waitForFunction(() => {
      const clerk = (
        window as Window & {
          Clerk?: { loaded?: boolean; user?: { id?: string } | null };
        }
      ).Clerk;
      return clerk?.loaded === true && Boolean(clerk.user?.id);
    });
    if (options.requireUserButton !== false) {
      await expect(
        page.getByRole('button', { name: 'Open user menu' }),
      ).toBeVisible();
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: 'nextjs-portal { display: none !important; }',
  });
}

test('populated workspace, role workflows, credits, and admin rewards', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const testUrl = process.env.DATABASE_TEST_URL;
  if (!testUrl || new URL(testUrl).pathname !== '/career_workspace_test')
    throw new Error('Set DATABASE_TEST_URL to career_workspace_test.');
  process.env.DATABASE_URL = testUrl;

  const database = getDatabase();
  const cleanup = {
    facts: [] as string[],
    jobs: [] as string[],
    opportunities: [] as string[],
    resumes: [] as string[],
    reviews: [] as string[],
    practices: [] as string[],
    drafts: [] as string[],
    posts: [] as string[],
    rewards: [] as string[],
    companies: [] as string[],
    projects: [] as string[],
  };
  let opportunityId: string | undefined;
  let userId: string | undefined;
  let originalRole: string | undefined;
  const stableDate = new Date('2026-01-15T12:00:00Z');

  try {
    const meResponse = await page.request.get('/api/v1/me');
    expect(meResponse.ok()).toBeTruthy();
    const me = (await meResponse.json()) as Envelope<{ id: string }>;
    userId = me.data?.id;
    expect(userId).toBeTruthy();

    const approvedText =
      'Built accessible TypeScript tools for student support.';
    const proposedText =
      'Led a team of four volunteers through a product launch.';
    const approved = await page.request.post('/api/v1/profile/facts', {
      data: { kind: 'skill', text: approvedText },
    });
    const proposed = await page.request.post('/api/v1/profile/facts', {
      data: { kind: 'experience', text: proposedText },
    });
    expect(approved.ok()).toBeTruthy();
    expect(proposed.ok()).toBeTruthy();
    const approvedFact = ((await approved.json()) as Envelope<{ id: string }>)
      .data!;
    const proposedFact = ((await proposed.json()) as Envelope<{ id: string }>)
      .data!;
    cleanup.facts.push(approvedFact.id, proposedFact.id);
    const approvedStatus = await page.request.patch(
      `/api/v1/profile/facts/${approvedFact.id}`,
      { data: { status: 'approved' } },
    );
    expect(approvedStatus.ok()).toBeTruthy();

    const roleResponse = await page.request.post('/api/v1/jobs', {
      data: {
        title: 'Product engineer',
        company: 'Northstar Labs',
        text: 'Build accessible TypeScript tools for student support. Work with product designers, write reliable tests, and lead a team of four through product launches. Experience with public cloud operations is helpful.',
      },
    });
    expect(roleResponse.ok()).toBeTruthy();
    const role = (
      (await roleResponse.json()) as Envelope<{
        job: { id: string };
        opportunity: { id: string };
      }>
    ).data!;
    const jobId = role.job.id;
    opportunityId = role.opportunity.id;
    cleanup.jobs.push(jobId);
    cleanup.opportunities.push(opportunityId);
    await database
      .update(events)
      .set({ createdAt: stableDate })
      .where(
        and(
          eq(events.userId, userId!),
          eq(events.subjectType, 'opportunity'),
          eq(events.subjectId, opportunityId),
        ),
      );

    const [review] = await database
      .insert(fitReviews)
      .values({
        userId: userId!,
        opportunityId,
        verdict: 'Good starting match',
        strengths: [
          {
            text: 'Built accessible TypeScript tools for student support.',
            fact_ids: [approvedFact.id],
          },
        ],
        gaps: ['No approved evidence of public cloud operations yet.'],
        unknowns: ['The role does not say what testing tools the team uses.'],
        scorecard: {
          score: 3.9,
          band: 'stretch',
          rawScore: 4.4,
          capReason: 'mostly_unknown_essentials',
          confidence: 'low',
          nextAction:
            'Confirm what reliable testing experience the role expects.',
          requirements: [
            {
              text: 'Accessible TypeScript tools',
              quote: 'Build accessible TypeScript tools for student support.',
              importance: 'essential',
              status: 'met',
              fact_ids: [approvedFact.id],
              nominalWeight: 3,
              weight: 3,
              contribution: 3.43,
            },
            {
              text: 'Work with product designers',
              quote: 'Work with product designers,',
              importance: 'essential',
              status: 'unknown',
              fact_ids: [],
              nominalWeight: 3,
              weight: 0,
              contribution: 0,
            },
            {
              text: 'Write reliable tests',
              quote: 'write reliable tests,',
              importance: 'essential',
              status: 'unknown',
              fact_ids: [],
              nominalWeight: 3,
              weight: 0,
              contribution: 0,
            },
            {
              text: 'Public cloud operations',
              quote: 'Experience with public cloud operations is helpful.',
              importance: 'desirable',
              status: 'gap',
              fact_ids: [],
              nominalWeight: 0.5,
              weight: 0.5,
              contribution: 0,
            },
          ],
          factors: {
            cvMatch: {
              met: 1,
              total: 4,
              unknown: 2,
              weightedMet: 3,
              weightedTotal: 3.5,
            },
            targetRoleAlignment: { status: 'unknown', matchedRole: null },
            compensation: { status: 'not_stated', evidence: null },
            culture: { status: 'not_stated', evidence: null },
            constraints: [],
          },
          checks: [
            'Confirm reliable testing experience.',
            'Check the team’s testing tools.',
          ],
          matched: ['Accessible TypeScript tools'],
          gaps: ['Public cloud operations'],
          evidence: {
            cvMatch: 'partial',
            targetRoleAlignment: 'unknown',
            compensation: 'unknown',
            culture: 'unknown',
            redFlags: 'unknown',
          },
        } satisfies FitScorecard,
        promptVersion: 'visual-fixture.v1',
        model: 'recorded-visual-fixture',
      })
      .returning();
    cleanup.reviews.push(review.id);

    const content = {
      name: 'Casey Candidate',
      contact: 'casey@example.test',
      sections: [
        {
          title: 'Selected experience',
          bullets: [
            { text: approvedText, fact_ids: [approvedFact.id] },
            { text: proposedText, fact_ids: [proposedFact.id] },
          ],
        },
      ],
    };
    const [resume] = await database
      .insert(resumeVersions)
      .values({
        userId: userId!,
        opportunityId,
        content,
        version: 1,
        groundingFlags: [{ index: 1, codes: ['fact_not_approved'] }],
        promptVersion: 'visual-fixture.v1',
        model: 'recorded-visual-fixture',
      })
      .returning();
    cleanup.resumes.push(resume.id);

    const [project] = await database
      .insert(projects)
      .values({
        userId: userId!,
        title: 'Community Tech Workshops',
        summary: 'A stable visual fixture for a reviewed social post.',
        createdAt: stableDate,
        updatedAt: stableDate,
      })
      .returning();
    cleanup.projects.push(project.id);
    const [projectFact] = await database
      .insert(profileFacts)
      .values({
        userId: userId!,
        projectId: project.id,
        kind: 'achievement',
        text: 'Helped 30 students build their first accessible websites.',
        source: 'project',
        status: 'approved',
        createdAt: stableDate,
        updatedAt: stableDate,
      })
      .returning();
    cleanup.facts.push(projectFact.id);
    const [post] = await database
      .insert(posts)
      .values({
        userId: userId!,
        projectId: project.id,
        content: 'I helped 30 students build their first accessible websites.',
        factIds: [projectFact.id],
        destination: 'copy',
        approvedContent:
          'I helped 30 students build their first accessible websites.',
        approvedDestination: {
          destination: 'copy',
          connectionId: null,
          accountId: null,
          platform: null,
        },
        approvedAt: stableDate,
        status: 'copy_ready',
        promptVersion: 'visual-fixture.v1',
        model: 'recorded-visual-fixture',
        createdAt: stableDate,
        updatedAt: stableDate,
      })
      .returning();
    cleanup.posts.push(post.id);

    const [company] = await database
      .insert(companies)
      .values({
        name: 'Northstar Labs',
        normalizedName: `northstar-labs-${randomUUID()}`,
        domain: null,
        createdAt: stableDate,
      })
      .returning();
    cleanup.companies.push(company.id);
    const [contact] = await database
      .insert(contacts)
      .values({
        userId: userId!,
        opportunityId,
        companyId: company.id,
        providerContactId: `visual-${randomUUID()}`,
        name: 'Jordan Lee',
        title: 'Engineering Manager',
        email: 'jordan.lee@example.test',
        emailStatus: 'VALID',
        revealedAt: stableDate,
        source: 'getleads',
        sourceDate: stableDate,
        createdAt: stableDate,
      })
      .returning();
    const [outreach] = await database
      .insert(outreachDrafts)
      .values({
        userId: userId!,
        opportunityId,
        contactId: contact.id,
        subject: 'A question about the Product Engineer role',
        body: 'Hello Jordan, I was glad to see Northstar Labs supporting accessible products. I would welcome the chance to learn more.',
        factIds: [approvedFact.id],
        status: 'draft',
        promptVersion: 'visual-fixture.v1',
        model: 'recorded-visual-fixture',
        createdAt: stableDate,
        updatedAt: stableDate,
      })
      .returning();
    cleanup.drafts.push(outreach.id);

    const [practice] = await database
      .insert(practiceSessions)
      .values({
        userId: userId!,
        opportunityId,
        questions: [
          {
            question:
              'Tell me about a project where you improved access for users.',
            focus: 'Describe your steps and the outcome.',
          },
          {
            question: 'How do you decide what to build next?',
            focus: 'Explain how you use feedback.',
          },
          {
            question:
              'Tell me about a time you worked through a difficult bug.',
            focus: 'Share how you investigated it.',
          },
        ],
        answers: [
          'I interviewed students and changed the keyboard navigation.',
          'I look for a repeated user need and test a small improvement.',
          'I reduced the issue to one component and added a regression test.',
        ],
        feedback: {
          overall:
            'Your examples are specific and easy to follow. Add a clearer result to each story.',
          strengths: [
            'You explain how you gathered user evidence.',
            'You connect technical decisions to accessibility.',
          ],
          improvements: [
            'Add a clear before-and-after result to your examples.',
          ],
          nextSteps: ['Practice a shorter opening sentence for each story.'],
        },
        status: 'completed',
        answerHash: 'visual-fixture-answer-hash',
        questionPromptVersion: 'visual-fixture.v1',
        feedbackPromptVersion: 'visual-fixture.v1',
        model: 'recorded-visual-fixture',
        createdAt: stableDate,
        updatedAt: stableDate,
      })
      .returning();
    cleanup.practices.push(practice.id);

    const rewardUrl = `https://example.com/career-workspace-review/${randomUUID()}`;
    const [reward] = await database
      .insert(rewardSubmissions)
      .values({
        userId: userId!,
        url: rewardUrl,
        urlHash: createHash('sha256').update(rewardUrl).digest('hex'),
        disclosureConfirmed: true,
        status: 'pending',
        submittedAt: stableDate,
      })
      .returning();
    cleanup.rewards.push(reward.id);
    const [localUser] = await database
      .select()
      .from(users)
      .where(eq(users.id, userId!));
    originalRole = localUser?.role;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/workspace/profile');
    await settlePageForScreenshot(page);
    await expect(
      page.getByRole('heading', { name: 'Your profile' }),
    ).toBeVisible();
    await expect(page.getByText(approvedText)).toBeVisible();
    await expect(page.getByText(proposedText)).toBeVisible();
    await expectFullContentScreenshot(page, 'populated-profile-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });

    await page.goto('/workspace');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Roles' })
      .click();
    await expect(page.getByRole('heading', { name: 'My roles' })).toBeVisible();
    await page
      .getByRole('button', { name: 'Open Product engineer at Northstar Labs' })
      .click();
    await settlePageForScreenshot(page);
    await expect(
      page.getByText('No approved evidence of public cloud operations yet.'),
    ).toBeVisible();
    await expect(
      page.getByText(
        'The role does not say what testing tools the team uses.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(
      'A question about the Product Engineer role',
    );
    await checkRoleReviewScroll(page, testInfo);
    await expectFullContentScreenshot(page, 'populated-role-fit-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });

    await page.goto(`/workspace/roles/${opportunityId}/resume`);
    await settlePageForScreenshot(page);
    await expect(
      page.getByRole('heading', {
        name: 'Prepare: Product engineer at Northstar Labs',
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(
        'Approval is unavailable until every claim has at least one approved fact.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByLabel(
        'I checked my name and contact details, and that each CV line matches its supporting facts.',
      ),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Approve & download PDF' }),
    ).toBeDisabled();
    // This fixture deliberately contains an ungrounded claim, so the real
    // authenticated endpoint must refuse to export it, just as approval does.
    const pdfResponse = await page.request.get(
      `/api/v1/resumes/${resume.id}/pdf`,
    );
    expect(pdfResponse.status()).toBe(409);
    expect(await pdfResponse.json()).toMatchObject({
      error: { code: 'RESUME_NOT_GROUNDED' },
    });
    await expect(page).toHaveScreenshot('populated-cv-editor-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await page
      .getByLabel(
        'I checked my name and contact details, and that each CV line matches its supporting facts.',
      )
      .scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot('populated-cv-approval-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });

    await page.goto(`/workspace/roles/${opportunityId}`);
    await settlePageForScreenshot(page);
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
    await expect(page.getByText('Jordan Lee')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(
      'A question about the Product Engineer role',
    );
    await page
      .getByRole('textbox', { name: 'Subject' })
      .scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot(
      'populated-contacts-outreach-desktop.png',
      {
        fullPage: true,
        animations: 'disabled',
        mask: [page.getByRole('button', { name: 'Open user menu' })],
        maskColor: '#a79bce',
      },
    );

    await page.goto(`/workspace/roles/${opportunityId}/practice`);
    await settlePageForScreenshot(page);
    await expect(page.getByText('Practice feedback')).toBeVisible();
    await expect(
      page.getByText('Add a clear before-and-after result to your examples.'),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('populated-practice-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });

    await page.goto('/workspace/posts');
    await settlePageForScreenshot(page);
    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();
    await expect(
      page.getByText(
        'Helped 30 students build their first accessible websites.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('populated-posts-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await page
      .getByRole('button', { name: 'Copy approved text' })
      .scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot(
      'populated-posts-controls-desktop.png',
      {
        fullPage: true,
        animations: 'disabled',
        mask: [page.getByRole('button', { name: 'Open user menu' })],
        maskColor: '#a79bce',
      },
    );
    await page.getByRole('heading', { name: 'Posts' }).scrollIntoViewIfNeeded();

    await page.goto('/workspace/credits');
    await settlePageForScreenshot(page);
    await expect(
      page.getByRole('heading', { name: 'Your credits' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Earn credits by sharing your experience',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'View submitted post' }),
    ).toBeVisible();
    await database
      .update(ledgerEntries)
      .set({ createdAt: stableDate })
      .where(eq(ledgerEntries.userId, userId!));
    await page.reload();
    await settlePageForScreenshot(page);
    await expect(
      page.getByRole('heading', { name: 'What actions cost' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Add credits' }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('populated-credits-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await page
      .getByRole('heading', { name: 'Credit history' })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole('columnheader', { name: 'Activity' }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(
      'populated-credit-history-desktop.png',
      {
        fullPage: true,
        animations: 'disabled',
        mask: [page.getByRole('button', { name: 'Open user menu' })],
        maskColor: '#a79bce',
      },
    );
    await page
      .getByRole('heading', { name: 'Your credits' })
      .scrollIntoViewIfNeeded();

    await database
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, userId!));
    await page.goto('/admin/rewards');
    await settlePageForScreenshot(page, {
      requireClerk: false,
      requireUserButton: false,
    });
    await expect(
      page.getByRole('heading', { name: 'Reward review queue' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open submitted post' }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('populated-admin-rewards-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.locator('li code')],
      maskColor: '#a79bce',
    });
    await database
      .update(users)
      .set({ role: originalRole ?? 'candidate' })
      .where(eq(users.id, userId!));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/workspace/profile');
    await settlePageForScreenshot(page);
    await expect(
      page.getByRole('heading', { name: 'Your profile' }),
    ).toBeVisible();
    await expect(page.getByText(approvedText)).toBeVisible();
    await expectFullContentScreenshot(page, 'populated-profile-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await page.goto('/workspace');
    await page
      .getByRole('navigation', { name: 'Phone navigation' })
      .getByRole('link', { name: 'Roles' })
      .click();
    await page
      .getByRole('button', { name: 'Open Product engineer at Northstar Labs' })
      .click();
    await settlePageForScreenshot(page);
    await expect(
      page.getByText('No approved evidence of public cloud operations yet.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(
      'A question about the Product Engineer role',
    );
    await expectFullContentScreenshot(page, 'populated-role-fit-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await expectNoHorizontalOverflow(page, 390);
    await page.setViewportSize({ width: 320, height: 844 });
    await expectNoHorizontalOverflow(page, 320);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/workspace/roles/${opportunityId}/resume`);
    await settlePageForScreenshot(page);
    await expect(
      page.getByRole('button', { name: 'Approve & download PDF' }),
    ).toBeDisabled();
    await expect(page).toHaveScreenshot('populated-cv-editor-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    const phoneApprovalCheck = page.getByLabel(
      'I checked my name and contact details, and that each CV line matches its supporting facts.',
    );
    await phoneApprovalCheck.scrollIntoViewIfNeeded();
    await expect(phoneApprovalCheck).toBeVisible();
    await expectFullContentScreenshot(page, 'populated-cv-approval-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });

    // Check a separate grounded version after the CV screenshots so it cannot
    // change which resume version the workspace displays in those screenshots.
    const [groundedResume] = await database
      .insert(resumeVersions)
      .values({
        userId: userId!,
        opportunityId: opportunityId!,
        content: {
          name: 'Casey Candidate',
          contact: 'casey@example.test',
          sections: [
            {
              title: 'Selected experience',
              bullets: [{ text: approvedText, fact_ids: [approvedFact.id] }],
            },
          ],
        },
        version: 2,
        groundingFlags: [],
        promptVersion: 'visual-fixture.v1',
        model: 'recorded-visual-fixture',
      })
      .returning();
    cleanup.resumes.push(groundedResume.id);
    const groundedPdfResponse = await page.request.get(
      `/api/v1/resumes/${groundedResume.id}/pdf`,
    );
    expect(groundedPdfResponse.status()).toBe(200);
    expect(groundedPdfResponse.headers()['content-type']).toContain(
      'application/pdf',
    );
    await database
      .delete(resumeVersions)
      .where(eq(resumeVersions.id, groundedResume.id));

    await page.goto(`/workspace/roles/${opportunityId}`);
    await settlePageForScreenshot(page);
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(
      'A question about the Product Engineer role',
    );
    await page
      .getByRole('textbox', { name: 'Subject' })
      .scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot(
      'populated-contacts-outreach-phone.png',
      {
        fullPage: true,
        animations: 'disabled',
        mask: [page.getByRole('button', { name: 'Open user menu' })],
        maskColor: '#a79bce',
      },
    );
    await page.goto(`/workspace/roles/${opportunityId}/practice`);
    await settlePageForScreenshot(page);
    await expect(page.getByText('Practice feedback')).toBeVisible();
    await expect(page).toHaveScreenshot('populated-practice-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await page.goto('/workspace/posts');
    await settlePageForScreenshot(page);
    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Copy approved text' }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('populated-posts-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await page
      .getByRole('button', { name: 'Copy approved text' })
      .scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot('populated-posts-controls-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await page.getByRole('heading', { name: 'Posts' }).scrollIntoViewIfNeeded();
    await page.goto('/workspace/credits');
    await settlePageForScreenshot(page);
    await expect(
      page.getByRole('heading', { name: 'Your credits' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'View submitted post' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'What actions cost' }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('populated-credits-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await page
      .getByRole('heading', { name: 'Credit history' })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole('columnheader', { name: 'Activity' }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('populated-credit-history-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.getByRole('button', { name: 'Open user menu' })],
      maskColor: '#a79bce',
    });
    await database
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, userId!));
    await page.goto('/admin/rewards');
    await settlePageForScreenshot(page, {
      requireClerk: false,
      requireUserButton: false,
    });
    await expect(
      page.getByRole('heading', { name: 'Reward review queue' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open submitted post' }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('populated-admin-rewards-phone.png', {
      fullPage: true,
      animations: 'disabled',
      mask: [page.locator('li code')],
      maskColor: '#a79bce',
    });
  } finally {
    if (userId && originalRole)
      await database
        .update(users)
        .set({ role: originalRole })
        .where(eq(users.id, userId));
    if (cleanup.resumes.length)
      await database
        .delete(resumeVersions)
        .where(eq(resumeVersions.opportunityId, opportunityId!));
    if (cleanup.reviews.length)
      await database
        .delete(fitReviews)
        .where(eq(fitReviews.opportunityId, opportunityId!));
    for (const id of cleanup.practices)
      await database
        .delete(practiceSessions)
        .where(eq(practiceSessions.id, id));
    for (const id of cleanup.drafts)
      await database.delete(outreachDrafts).where(eq(outreachDrafts.id, id));
    for (const id of cleanup.posts)
      await database.delete(posts).where(eq(posts.id, id));
    for (const id of cleanup.rewards)
      await database
        .delete(rewardSubmissions)
        .where(eq(rewardSubmissions.id, id));
    if (cleanup.opportunities.length)
      await database
        .delete(opportunities)
        .where(eq(opportunities.id, opportunityId!));
    if (cleanup.jobs.length)
      await database.delete(jobs).where(eq(jobs.id, cleanup.jobs[0]));
    for (const factId of cleanup.facts)
      await database.delete(profileFacts).where(eq(profileFacts.id, factId));
    for (const id of cleanup.projects)
      await database.delete(projects).where(eq(projects.id, id));
    for (const id of cleanup.companies)
      await database.delete(companies).where(eq(companies.id, id));
  }
});
