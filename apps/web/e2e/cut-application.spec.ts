import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Route } from '@playwright/test';
import { and, eq, inArray } from 'drizzle-orm';
import { getPrivateStorage } from '@career-workspace/adapters/storage';
import {
  files,
  getDatabase,
  jobs,
  profileFacts,
  tasks,
} from '@career-workspace/db';
import { expect, test } from './fixtures';

async function recordedProvider<T>(input: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/web/e2e/cut-provider-fixture.mts'],
      { env: process.env },
    );
    let output = '';
    let diagnostics = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code) reject(new Error(`Recorded fixture failed: ${diagnostics}`));
      else {
        try {
          resolve(JSON.parse(output));
        } catch (cause) {
          reject(cause);
        }
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// This is an honest UI proof with recorded AI output. The test intercepts fit,
// CV-upload, and draft routes and invokes core with recorded replies, so it
// does not prove live provider or production workflow behavior.
test('recorded-provider UI proof: first role through PDF and apply check-in', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  if (
    new URL(process.env.DATABASE_TEST_URL!).pathname !==
    '/career_workspace_test'
  )
    throw new Error('Use the isolated test database only.');
  const database = getDatabase();
  const me = (await (await page.request.get('/api/v1/me')).json()).data;
  const userId = me.id as string;
  const marker = randomUUID().slice(0, 8);
  const factText = `Built a TypeScript student project ${marker}.`;
  const fileIds: string[] = [];
  let jobId: string | undefined;
  let opportunityId: string | undefined;
  let taskId: string | undefined;
  let factId: string | undefined;
  let draftCalls = 0;
  const initialDraftRequests: { route: Route; key: string; body: { confirmedSkills?: boolean; preparationToken?: string } }[] = [];
  const explicitDraftKeys: string[] = [];
  let releaseInitialDrafts!: () => void;
  const initialDraftGate = new Promise<void>((resolveGate) => {
    releaseInitialDrafts = resolveGate;
  });
  // Another test may leave profile facts on the shared test identity. Keep
  // those records intact; hide them only from this test's UI and AI input.
  const oldFacts = await database
    .select()
    .from(profileFacts)
    .where(eq(profileFacts.userId, userId));
  try {
    await database
      .update(profileFacts)
      .set({ status: 'rejected' })
      .where(eq(profileFacts.userId, userId));
    await page.route('**/api/v1/opportunities/*/fit-review', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const id = new URL(route.request().url()).pathname.split('/')[4];
      const review = await recordedProvider({
        action: 'fit',
        userId,
        id,
        key: route.request().headers()['idempotency-key'],
      });
      await route.fulfill({ json: { data: review } });
    });
    await page.route('**/api/v1/profile/cv', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      // Chromium's intercepted postData omits uploaded file bytes. Use the
      // exact fixture selected below; the regular upload test checks transport.
      expect(route.request().postData()).toContain('sample-cv.docx');
      const uploaded = await page.request.post('/api/v1/files', {
        multipart: {
          file: {
            name: 'sample-cv.docx',
            mimeType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            buffer: await readFile(
              resolve('packages/adapters/src/fixtures/sample-cv.docx'),
            ),
          },
        },
      });
      expect(uploaded.status(), await uploaded.text()).toBe(201);
      const file = (await uploaded.json()).data;
      fileIds.push(file.id);
      const completed = await recordedProvider<{
        id: string;
        output: { factIds: string[] };
      }>({ action: 'cv', userId, id: file.id, factText });
      taskId = completed.id;
      factId = (completed.output as { factIds: string[] }).factIds[0];
      await route.fulfill({
        status: 201,
        json: { data: { file, task: completed } },
      });
    });
    const handleDraftRequest = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      draftCalls++;
      const key = route.request().headers()['idempotency-key'] ?? '';
      if (initialDraftRequests.length < 2) {
        initialDraftRequests.push({
          route,
          key,
          body: route.request().postDataJSON() as { confirmedSkills?: boolean; preparationToken?: string },
        });
        if (initialDraftRequests.length === 2) {
          // Hold the first confirmed generation until a second tab also
          // confirms. Both first-draft requests must reuse one stable key.
          for (const request of initialDraftRequests) {
            expect(request.body.confirmedSkills).toBe(true);
            expect(request.body.preparationToken).toMatch(/^[0-9a-f]{64}$/);
            const id = new URL(request.route.request().url()).pathname.split(
              '/',
            )[4];
            const resume = await recordedProvider({
              action: 'resume',
              userId,
              id,
              key: request.key,
              factText,
              factId,
            });
            await request.route.fulfill({
              status: 201,
              json: { data: resume },
            });
          }
          releaseInitialDrafts();
        } else {
          await initialDraftGate;
        }
        return;
      }

      const body = route.request().postDataJSON() as { confirmedSkills?: boolean; preparationToken?: string };
      expect(body.confirmedSkills).toBe(true);
      expect(body.preparationToken).toMatch(/^[0-9a-f]{64}$/);
      explicitDraftKeys.push(key);
      // Capture the explicit redraft key without invoking a provider or
      // charging test credits; the existing first draft remains on screen.
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'TEST_KEY_CAPTURED',
            message: 'Draft request captured; no draft was generated.',
          },
        },
      });
    };
    await page.route('**/api/v1/opportunities/*/resumes', handleDraftRequest);
    await page.goto('/workspace?view=roles&add=1');
    await page
      .getByLabel('Job title', { exact: true })
      .fill(`Graduate developer ${marker}`);
    await page.getByLabel('Company', { exact: true }).fill('Student Studio');
    await page
      .getByLabel('Or paste the role description')
      .fill(
        'Build accessible TypeScript products with a small engineering team. Work on site, collaborate with designers, write clear tests, and communicate progress while learning from experienced developers.',
      );
    await page
      .getByRole('button', { name: 'Save role and add CV', exact: true })
      .click();
    await expect(page).toHaveURL(/\/workspace\?setup=cv&returnRole=[0-9a-f-]+/);
    const rows = (
      await (await page.request.get('/api/v1/opportunities')).json()
    ).data;
    const role = rows.find(
      (item: { job: { title: string } }) =>
        item.job.title === `Graduate developer ${marker}`,
    );
    jobId = role.job.id;
    opportunityId = role.opportunity.id;
    await expect(
      page.getByRole('heading', {
        name: 'Add your CV for a personal fit review',
      }),
    ).toBeVisible();
    await page
      .getByLabel('Choose your CV')
      .setInputFiles(resolve('packages/adapters/src/fixtures/sample-cv.docx'));
    await expect(
      page.getByRole('heading', { name: 'Does this sound like you?' }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByText('Review details (1 facts)').click();
    const fact = page.getByLabel('Edit skill fact');
    await expect(fact).toHaveValue(factText);
    await page.setViewportSize({ width: 1280, height: 900 });
    await fact.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('cv-facts-desktop.png'),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await fact.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('cv-facts-phone.png') });
    await expect(
      page.getByText(
        'No verified CV quote. Check this carefully before selecting it.',
      ),
    ).toBeVisible();
    await page.getByLabel('Include this skill').check();
    await page.getByRole('button', { name: 'Looks right, continue' }).click();
    await expect(page).toHaveURL(`/workspace/roles/${opportunityId}?review=1`);
    await expect(
      page.getByText(
        'Your personal fit is not known yet. Review these requirements first.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText('The role requires working on site.', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Prepare this application · CV 3 credits' })
      .click();
    await expect(page).toHaveURL(
      `/workspace/roles/${opportunityId}/resume?prepare=1`,
    );
    const secondPage = await page.context().newPage();
    await secondPage.route(
      '**/api/v1/opportunities/*/resumes',
      handleDraftRequest,
    );
    await secondPage.goto(`/workspace/roles/${opportunityId}/resume?prepare=1`);
    await expect(page.getByRole('heading', { name: 'Review the role before creating a CV' })).toBeVisible();
    await expect(secondPage.getByRole('heading', { name: 'Review the role before creating a CV' })).toBeVisible();
    const preparationCheckbox = page.getByRole('checkbox', { name: /reviewed this comparison/i });
    const secondPreparationCheckbox = secondPage.getByRole('checkbox', { name: /reviewed this comparison/i });
    await expect(page.getByRole('button', { name: 'Create tailored CV · 3 credits' })).toBeDisabled();
    await expect(secondPage.getByRole('button', { name: 'Create tailored CV · 3 credits' })).toBeDisabled();
    await preparationCheckbox.check();
    await secondPreparationCheckbox.check();
    await page.getByRole('button', { name: 'Create tailored CV · 3 credits' }).click();
    await secondPage.getByRole('button', { name: 'Create tailored CV · 3 credits' }).click();
    await expect.poll(() => initialDraftRequests.length).toBe(2);
    await expect(
      page.getByRole('button', { name: 'Approve & download PDF', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      secondPage.getByRole('button', {
        name: 'Approve & download PDF',
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
    expect(initialDraftRequests[0].key).toMatch(/^prepare:/);
    expect(initialDraftRequests[1].key).toBe(initialDraftRequests[0].key);
    expect(draftCalls).toBe(2);
    await secondPage.close();

    await page
      .getByRole('button', {
        name: 'Review before creating another draft',
        exact: true,
      })
      .click();
    await expect(page.getByRole('checkbox', { name: /reviewed this comparison/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create tailored CV · 3 credits' })).toBeDisabled();
    await page.getByRole('checkbox', { name: /reviewed this comparison/i }).check();
    await page.getByRole('button', { name: 'Create tailored CV · 3 credits' }).click();
    await expect.poll(() => explicitDraftKeys.length).toBe(1);
    expect(explicitDraftKeys[0]).not.toBe(initialDraftRequests[0].key);
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Draft request captured; no draft was generated.' }),
    ).toBeVisible();
    expect(draftCalls).toBe(3);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Test Student');
    await page
      .getByLabel('Contact details (email or phone)', { exact: true })
      .fill('student@example.test');
    await page.getByRole('button', { name: 'Save new version' }).click();
    await expect(page.getByText(/Saved as CV version/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page
      .getByLabel(
        'I checked my name and contact details, and that each CV line matches its supporting facts.',
      )
      .check();
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Approve & download PDF', exact: true })
      .click();
    expect((await download).suggestedFilename()).toBe('Test-Student-CV.pdf');
    await expect(
      page.getByRole('button', { name: 'CV approved', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('approved-cv-phone.png'),
    });
    await expect(
      page.getByRole('status').filter({ hasText: 'PDF downloaded.' }),
    ).toBeVisible();
    await page.goto('/workspace');
    await page
      .getByText('Follow-ups and application check-ins', { exact: true })
      .click();
    await expect(
      page.getByRole('heading', {
        name: `Did you apply to Graduate developer ${marker} at Student Studio?`,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Not yet', exact: true }).click();
    await expect(page.getByText(/stays in preparation/)).toBeVisible();
    expect(
      (
        await (
          await page.request.get(`/api/v1/opportunities/${opportunityId}`)
        ).json()
      ).data.opportunity.status,
    ).toBe('preparing');
    // A second real PDF download creates another check-in. No handoff is
    // created directly through the API in this browser proof.
    await page.goto(`/workspace/roles/${opportunityId}/resume`);
    await expect(
      page.getByRole('button', { name: 'Download approved PDF' }).first(),
    ).toBeVisible();
    const secondDownload = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download approved PDF' })
      .first()
      .click();
    expect((await secondDownload).suggestedFilename()).toBe(
      'Test-Student-CV.pdf',
    );
    // Download starts before the follow-up request finishes. Wait for the
    // visible completion message before navigation can cancel that request.
    await expect(
      page.getByRole('status').filter({ hasText: 'PDF downloaded. Your application follow-up is ready' }),
    ).toBeVisible();
    const resumes = (
      await (
        await page.request.get(`/api/v1/opportunities/${opportunityId}/resumes`)
      ).json()
    ).data;
    fileIds.push(resumes[0].pdfFileId);
    await page.goto('/workspace');
    await page
      .getByText('Follow-ups and application check-ins', { exact: true })
      .click();
    await expect(
      page.getByRole('heading', {
        name: `Did you apply to Graduate developer ${marker} at Student Studio?`,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Yes, I applied', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'is marked applied.' }),
    ).toBeVisible();
    expect(
      (
        await (
          await page.request.get(`/api/v1/opportunities/${opportunityId}`)
        ).json()
      ).data.opportunity.status,
    ).toBe('applied');
  } finally {
    if (jobId)
      await database
        .delete(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)));
    if (factId)
      await database
        .delete(profileFacts)
        .where(
          and(eq(profileFacts.id, factId), eq(profileFacts.userId, userId)),
        );
    if (taskId)
      await database
        .delete(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
    for (const fact of oldFacts)
      await database
        .update(profileFacts)
        .set({ status: fact.status })
        .where(eq(profileFacts.id, fact.id));
    if (fileIds.length) {
      const ownedFiles = await database
        .select()
        .from(files)
        .where(and(eq(files.userId, userId), inArray(files.id, fileIds)));
      for (const file of ownedFiles)
        await getPrivateStorage().delete(file.r2Key);
      await database
        .delete(files)
        .where(and(eq(files.userId, userId), inArray(files.id, fileIds)));
    }
  }
});
