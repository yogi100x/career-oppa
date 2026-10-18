import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createRefreshedBrowserContext, expect, test, type APIRequestContext } from './fixtures';
import { captureFullContentScreenshot } from './full-content-screenshot';
import { getDatabase, files, profileFacts } from '@career-workspace/db';
import { getPrivateStorage } from '@career-workspace/adapters/storage';
import { answerDrafts } from '../../../packages/db/src/answers-schema';
import { jobs } from '../../../packages/db/src/roles-schema';
import { resumeVersions } from '../../../packages/db/src/resumes-schema';

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

test('edit, restore, ground, and approve CV and answer drafts', async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const testUrl = process.env.DATABASE_TEST_URL;
  if (!testUrl || new URL(testUrl).pathname.slice(1) !== 'career_workspace_test')
    throw new Error('Set DATABASE_TEST_URL to the isolated career_workspace_test database.');
  process.env.DATABASE_URL = testUrl;

  const marker = randomUUID();
  const factText = `Built a tested TypeScript workspace ${marker}.`;
  let factId: string | undefined;
  let opportunityId: string | undefined;
  let jobId: string | undefined;
  let pdfFileId: string | undefined;
  let apiB: APIRequestContext | undefined;
  let browserBContext: Awaited<ReturnType<typeof createRefreshedBrowserContext>> | undefined;
  const database = getDatabase();

  try {
    const factResponse = await page.request.post('/api/v1/profile/facts', {
      data: { kind: 'skill', text: factText },
    });
    expect(factResponse.status()).toBe(200);
    factId = ((await factResponse.json()) as Envelope<{ id: string }>).data?.id;
    expect(factId).toBeTruthy();
    const factApproval = await page.request.patch(`/api/v1/profile/facts/${factId}`, {
      data: { status: 'approved' },
    });
    expect(factApproval.status()).toBe(200);

    const jobResponse = await page.request.post('/api/v1/jobs', {
      data: {
        title: `Resume proof ${marker}`,
        company: 'Browser fixture',
        text: 'Build and maintain accessible TypeScript products with product teams. Write tests, review code, and improve customer-facing tools. Communicate clearly and support reliable releases across the team.',
      },
    });
    expect(jobResponse.ok()).toBeTruthy();
    const jobData = (await jobResponse.json()) as Envelope<{ opportunity: { id: string }; job: { id: string } }>;
    opportunityId = jobData.data?.opportunity.id;
    jobId = jobData.data?.job.id;
    expect(opportunityId).toBeTruthy();
    expect(jobId).toBeTruthy();

    const meResponse = await page.request.get('/api/v1/me');
    const userId = ((await meResponse.json()) as Envelope<{ id: string }>).data?.id;
    expect(userId).toBeTruthy();
    const firstContent = {
      name: `Candidate ${marker}`,
      contact: 'candidate@example.test',
      sections: [{ title: 'Experience', bullets: [{ text: factText, fact_ids: [factId!] }] }],
    };
    await database.insert(resumeVersions).values({
      userId: userId!, opportunityId: opportunityId!, content: firstContent, version: 1,
      promptVersion: 'browser-fixture.v1', model: 'recorded-fixture',
    }).returning();
    const [answer] = await database.insert(answerDrafts).values({
      userId: userId!, opportunityId: opportunityId!, question: `How have you used TypeScript? ${marker}`,
      answer: factText, factIds: [factId!], promptVersion: 'browser-fixture.v1', model: 'recorded-fixture',
    }).returning();

    await page.route(`**/api/v1/opportunities/${opportunityId}/resumes/preparation`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            token: 'browser-preparation-token',
            skills: {
              buckets: {
                existing: [{ id: 'existing-skill', skill: 'TypeScript', kind: 'existing', priority: 'essential', factIds: [factId] }],
                supportedByResume: [{ id: 'project-skill', skill: 'Testing', kind: 'supported_by_resume', priority: 'desirable', factIds: [factId] }],
                gaps: [{ id: 'gap-skill', skill: 'Product research', kind: 'gap', priority: 'desirable', factIds: [] }],
              },
              incompleteDetection: true,
              incompleteRequirements: ['The job description may have additional requirements.'],
            },
            requirements: [{ text: 'TypeScript', quote: 'Build accessible TypeScript products.', importance: 'essential', status: 'met', fact_ids: [factId], nominalWeight: 1, weight: 1, contribution: 1 }],
            reuse: [{ resumeId: 'existing-resume', opportunityId, title: 'Previous CV', company: 'Example Co', approved: false, similarity: 0.62, action: 'edit', reason: 'similarity_medium' }],
          },
        }),
      });
    });
    await page.goto(`/workspace/roles/${opportunityId}/resume`);
    await expect(page.getByRole('heading', { name: `Prepare: Resume proof ${marker} at Browser fixture` })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTitle('Tailored CV PDF preview')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(factText, { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Review before creating another draft' }).click();
    await expect(page.getByRole('heading', { name: 'Review the role before creating a CV' })).toBeVisible();
    await expect(page.getByText('Some job requirements may be missing from this comparison.')).toBeVisible();
    await expect(page.getByText('Supported by other approved facts')).toBeVisible();
    await expect(page.getByRole('link', { name: 'View approved facts for TypeScript' })).toHaveAttribute('href', '/workspace/profile#facts-heading');
    await expect(page.getByRole('listitem').filter({ hasText: /TypeScript\s+Essential/ }).first()).toBeVisible();
    await page.getByText(/Job requirements and evidence/).click();
    await expect(page.getByText('TypeScript', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit for this role · no charge from Previous CV at Example Co' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create tailored CV · 3 credits' })).toBeDisabled();
    const createButton = page.getByRole('button', { name: 'Create tailored CV · 3 credits' });
    await page.getByRole('checkbox', { name: /reviewed this comparison/i }).check();
    await expect(createButton).toBeEnabled();
    await createButton.scrollIntoViewIfNeeded();
    await expect.poll(() => createButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && button.contains(hit));
    })).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await captureFullContentScreenshot(page, testInfo.outputPath('resume-preparation-desktop.png'));
    await page.setViewportSize({ width: 390, height: 844 });
    await createButton.scrollIntoViewIfNeeded();
    await expect.poll(() => createButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && button.contains(hit));
    })).toBe(true);
    await captureFullContentScreenshot(page, testInfo.outputPath('resume-preparation-phone.png'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('checkbox', { name: /reviewed this comparison/i }).uncheck();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const atsAudit = page.getByRole('region', { name: 'PDF readability check' });
    await expect(atsAudit.getByRole('heading', { name: 'PDF readability check' })).toBeVisible();
    const checksDisclosure = atsAudit.getByText(/View all \d+ PDF checks/);
    await expect(checksDisclosure).toBeVisible();
    await checksDisclosure.click();
    await expect(atsAudit.getByText(/Passed · \d+ of \d+ points\./).first()).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await captureFullContentScreenshot(page, testInfo.outputPath('resume-ats-checks-desktop.png'));
    await page.setViewportSize({ width: 390, height: 844 });
    const lastPdfCheck = atsAudit.locator('details li').last();
    await lastPdfCheck.scrollIntoViewIfNeeded();
    await expect.poll(() => lastPdfCheck.evaluate((row) => {
      const rect = row.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && row.contains(hit));
    })).toBe(true);
    const iframe = page.locator('iframe').first();
    const iframeStyle = await iframe.evaluate((element) => {
      const previous = element.getAttribute('style');
      element.style.height = getComputedStyle(element).height;
      return previous;
    });
    const factChoiceStyle = await page.locator('[class*="factChoices"]').evaluate((element) => {
      if (element.scrollHeight <= element.clientHeight) return null;
      const previous = element.getAttribute('style');
      (element as HTMLElement).style.maxHeight = 'none';
      (element as HTMLElement).style.overflowY = 'visible';
      return previous;
    }).catch(() => null);
    try {
      await captureFullContentScreenshot(page, testInfo.outputPath('resume-ats-checks-phone.png'));
    } finally {
      await iframe.evaluate((element, style) => {
        if (style) element.setAttribute('style', style);
        else element.removeAttribute('style');
      }, iframeStyle);
      if (factChoiceStyle !== null) {
        await page.locator('[class*="factChoices"]').evaluate((element, style) => {
          if (style) element.setAttribute('style', style);
          else element.removeAttribute('style');
        }, factChoiceStyle);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await mkdir('output', { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('[aria-labelledby="cv-title"] [class*="evidence"]').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/resume-editor-desktop.png' });
    await page.getByLabel('I checked my name and contact details, and that each CV line matches its supporting facts.').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/resume-approval-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[aria-labelledby="cv-title"] [class*="evidence"]').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/resume-editor-phone.png' });
    await page.getByLabel('I checked my name and contact details, and that each CV line matches its supporting facts.').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/resume-approval-phone.png' });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByLabel('Name', { exact: true }).fill(`Edited ${marker}`);
    await page.getByRole('button', { name: 'Save new version' }).click();
    await expect(page.getByText('Saved as CV version 2.')).toBeVisible();
    await page.getByText(/^Version history/).click();
    await page.getByRole('button', { name: 'Restore as new draft' }).click();
    await expect(page.getByText('Restored as new draft version 3. Review it before approval.')).toBeVisible();
    await page.getByLabel('I checked my name and contact details, and that each CV line matches its supporting facts.').check();
    await page.getByRole('button', { name: 'Approve & download PDF' }).click();
    await expect(page.getByRole('button', { name: 'CV approved' })).toBeVisible({ timeout: 15_000 });
    const resumeListResponse = await page.request.get(`/api/v1/opportunities/${opportunityId}/resumes`);
    const resumeVersionsForRole = ((await resumeListResponse.json()) as Envelope<Array<{ id: string; approvedAt: string | null; pdfFileId: string | null }>>).data;
    const approvedResume = resumeVersionsForRole?.[0];
    expect(approvedResume?.approvedAt).toBeTruthy();
    pdfFileId = approvedResume?.pdfFileId ?? undefined;
    expect(pdfFileId).toBeTruthy();
    const previewPdf = await page.request.get(`/api/v1/resumes/${approvedResume!.id}/pdf`);
    expect(previewPdf.status()).toBe(200);
    expect(previewPdf.headers()['content-type']).toContain('application/pdf');
    const downloadedPdf = await page.request.get(`/api/v1/files/${pdfFileId}`);
    expect(downloadedPdf.status()).toBe(200);
    expect(downloadedPdf.headers()['content-type']).toContain('application/pdf');

    browserBContext = await createRefreshedBrowserContext(
      browser,
      resolve('apps/web/e2e/.auth/user-b.json'),
      testInfo.project.use.baseURL as string,
    );
    apiB = browserBContext.page.request;
    const forbiddenCvRequests = await Promise.all([
      apiB.get(`/api/v1/resumes/${approvedResume!.id}`),
      apiB.patch(`/api/v1/resumes/${approvedResume!.id}`, { data: { content: firstContent } }),
      apiB.get(`/api/v1/resumes/${approvedResume!.id}/grounding`),
      apiB.post(`/api/v1/resumes/${approvedResume!.id}/restore`),
      apiB.get(`/api/v1/files/${pdfFileId}`),
    ]);
    for (const response of forbiddenCvRequests) expect(response.status()).toBe(404);

    await expect(page.getByText(answer.question, { exact: true })).toBeVisible();
    await page.getByLabel('I checked this answer against its supporting facts.').check();
    await page.getByRole('button', { name: 'Approve answer' }).click();
    await expect(page.getByRole('button', { name: 'Answer approved' })).toBeVisible();
  } finally {
    await browserBContext?.close();
    if (opportunityId) {
      await database.delete(resumeVersions).where(eq(resumeVersions.opportunityId, opportunityId));
      await database.delete(answerDrafts).where(eq(answerDrafts.opportunityId, opportunityId));
    }
    if (pdfFileId) {
      const [pdfFile] = await database.select({ r2Key: files.r2Key }).from(files).where(eq(files.id, pdfFileId));
      if (pdfFile) await getPrivateStorage().delete(pdfFile.r2Key).catch(() => undefined);
      await database.delete(files).where(eq(files.id, pdfFileId));
    }
    if (jobId) await database.delete(jobs).where(eq(jobs.id, jobId));
    if (factId) await database.delete(profileFacts).where(eq(profileFacts.id, factId));
  }
});

test('reusing a CV after a lost response retries with the same key', async ({ page }) => {
  test.setTimeout(60_000);
  const testUrl = process.env.DATABASE_TEST_URL;
  if (!testUrl || new URL(testUrl).pathname.slice(1) !== 'career_workspace_test')
    throw new Error('Set DATABASE_TEST_URL to the isolated career_workspace_test database.');
  process.env.DATABASE_URL = testUrl;

  const marker = randomUUID();
  const database = getDatabase();
  let factId: string | undefined;
  let targetJobId: string | undefined;
  let targetOpportunityId: string | undefined;
  let sourceJobId: string | undefined;
  let sourceOpportunityId: string | undefined;

  try {
    const factResponse = await page.request.post('/api/v1/profile/facts', {
      data: { kind: 'skill', text: `Approved testing experience ${marker}.` },
    });
    expect(factResponse.status()).toBe(200);
    factId = ((await factResponse.json()) as Envelope<{ id: string }>).data?.id;
    expect(factId).toBeTruthy();
    const approval = await page.request.patch(`/api/v1/profile/facts/${factId}`, {
      data: { status: 'approved' },
    });
    expect(approval.status()).toBe(200);

    const me = await page.request.get('/api/v1/me');
    const userId = ((await me.json()) as Envelope<{ id: string }>).data?.id;
    expect(userId).toBeTruthy();
    const createRole = async (title: string) => {
      const response = await page.request.post('/api/v1/jobs', {
        data: {
          title,
          company: 'Retry fixture',
          text: `${title}: responsibilities include reliable testing and clear communication across a supportive team. Requirements include practical testing experience, careful documentation, and clear written communication with colleagues.`,
        },
      });
      expect(response.ok()).toBeTruthy();
      return ((await response.json()) as Envelope<{
        opportunity: { id: string };
        job: { id: string };
      }>).data!;
    };
    const target = await createRole(`Retry target ${marker}`);
    targetOpportunityId = target.opportunity.id;
    targetJobId = target.job.id;
    const source = await createRole(`Retry source ${marker}`);
    sourceOpportunityId = source.opportunity.id;
    sourceJobId = source.job.id;
    const [sourceResume] = await database.insert(resumeVersions).values({
      userId: userId!,
      opportunityId: sourceOpportunityId,
      content: {
        name: `Candidate ${marker}`,
        contact: 'candidate@example.test',
        sections: [{ title: 'Experience', bullets: [{ text: `Approved testing experience ${marker}.`, fact_ids: [factId!] }] }],
      },
      version: 1,
      promptVersion: 'browser-reuse-retry.v1',
      model: 'recorded-fixture',
    }).returning();

    await page.route(`**/api/v1/opportunities/${targetOpportunityId}/resumes/preparation`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            token: 'browser-reuse-retry-preparation',
            skills: { buckets: { existing: [], supportedByResume: [], gaps: [] }, incompleteDetection: false, incompleteRequirements: [] },
            requirements: [],
            reuse: [{ resumeId: sourceResume.id, opportunityId: sourceOpportunityId, title: `Retry source ${marker}`, company: 'Retry fixture', approved: false, similarity: 0.7, action: 'reuse', reason: 'similarity_medium' }],
          },
        }),
      }),
    );

    const keys: string[] = [];
    await page.route(`**/api/v1/opportunities/${targetOpportunityId}/resumes`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (keys.length === 1) {
        const serverResponse = await route.fetch();
        const serverResponseText = await serverResponse.text();
        expect(serverResponse.ok(), `${serverResponse.status()}: ${serverResponseText}`).toBeTruthy();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.goto(`/workspace/roles/${targetOpportunityId}/resume`);
    const openPreparation = page.getByRole('button', {
      name: 'Review match before drafting',
    });
    await expect(openPreparation).toBeEnabled();
    await openPreparation.click();
    await expect(page.getByRole('heading', { name: 'Review the role before creating a CV' })).toBeVisible();
    const reuseButton = page.getByRole('button', {
      name: `Reuse as a new draft · no charge from Retry source ${marker} at Retry fixture`,
    });
    await reuseButton.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible();
    await expect(reuseButton).toBeEnabled();
    await reuseButton.click();
    await expect(page.getByText('A new unapproved CV draft is ready. Review it before approval.')).toBeVisible();

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    const targetResumesResponse = await page.request.get(`/api/v1/opportunities/${targetOpportunityId}/resumes`);
    expect(targetResumesResponse.ok()).toBeTruthy();
    const targetResumes = ((await targetResumesResponse.json()) as Envelope<Array<{ id: string }>>).data;
    expect(targetResumes).toHaveLength(1);
  } finally {
    if (targetOpportunityId) await database.delete(resumeVersions).where(eq(resumeVersions.opportunityId, targetOpportunityId));
    if (sourceOpportunityId) await database.delete(resumeVersions).where(eq(resumeVersions.opportunityId, sourceOpportunityId));
    if (targetJobId) await database.delete(jobs).where(eq(jobs.id, targetJobId));
    if (sourceJobId) await database.delete(jobs).where(eq(jobs.id, sourceJobId));
    if (factId) await database.delete(profileFacts).where(eq(profileFacts.id, factId));
  }
});
