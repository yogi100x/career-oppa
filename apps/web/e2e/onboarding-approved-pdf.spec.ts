import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  createDatabase,
  files,
  profileFacts,
  projects,
} from '@career-workspace/db';
import { jobs } from '../../../packages/db/src/roles-schema';
import { resumeVersions } from '../../../packages/db/src/resumes-schema';
import { LocalFolderStorage } from '@career-workspace/adapters/storage';
import { createRefreshedBrowserContext, expect, test } from './fixtures';

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

const testStorage = new LocalFolderStorage(resolve('apps/web/.local-storage'));

test('new Clerk user approves a fact and downloads an approved PDF', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  )
    throw new Error('Use the isolated browser test database.');
  if (!baseURL) throw new Error('Playwright baseURL is required.');
  const { database, pool } = createDatabase(databaseUrl);
  const session = await createRefreshedBrowserContext(
    browser,
    resolve('apps/web/e2e/.auth/user-d.json'),
    baseURL,
  );
  const { page } = session;
  const marker = randomUUID();
  const projectTitle = `Career journey project ${marker}`;
  const factText = `Built a tested scheduling tool for community members ${marker}.`;
  const roleTitle = `Accessible product engineer ${marker}`;
  const company = `Journey fixture ${marker}`;
  let projectId: string | undefined;
  let jobId: string | undefined;
  let opportunityId: string | undefined;
  let resumeId: string | undefined;

  try {
    await page.goto('/workspace');
    await expect(
      page.getByRole('heading', {
        name: /Your next step starts here\.|Find a role that fits you\./,
      }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Open user menu' }).click();
    await page
      .getByRole('menuitem')
      .filter({ hasText: 'Your profile' })
      .click();
    await page.getByLabel('Project name').fill(projectTitle);
    await page
      .getByLabel('What did you work on?')
      .fill(`I planned and built a scheduling tool. ${marker}`);
    await page.getByLabel('Add a claim for review (optional)').fill(factText);
    await page.getByRole('button', { name: 'Add project' }).click();

    const factTextNode = page.getByText(factText, { exact: true }).first();
    await expect(factTextNode).toBeVisible();
    const factCard = factTextNode.locator('xpath=..');
    await factCard.getByRole('button', { name: 'Approve' }).click();
    await expect(factCard).toContainText('approved');

    const meResponse = await page.request.get('/api/v1/me');
    expect(meResponse.status()).toBe(200);
    const me = (await meResponse.json()) as Envelope<{ id: string }>;
    if (!me.data?.id) throw new Error('The new workspace user was not loaded.');
    const [project] = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.userId, me.data.id), eq(projects.title, projectTitle)),
      )
      .limit(1);
    projectId = project?.id;
    expect(projectId).toBeTruthy();
    const [fact] = await database
      .select({ id: profileFacts.id, status: profileFacts.status })
      .from(profileFacts)
      .where(
        and(
          eq(profileFacts.userId, me.data.id),
          eq(profileFacts.text, factText),
        ),
      )
      .limit(1);
    expect(fact?.status).toBe('approved');

    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Roles' })
      .click();
    await page.getByRole('button', { name: 'Add a role' }).click();
    await page.getByLabel('Job title').fill(roleTitle);
    await page.getByLabel('Company').fill(company);
    await page
      .getByLabel('Or paste the role description')
      .fill(
        'Build accessible TypeScript applications with product partners. Write tests, review code, improve customer-facing tools, and help teams ship reliable changes.',
      );
    const roleResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/jobs') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save role' }).click();
    const roleResponse = await roleResponsePromise;
    expect(roleResponse.status()).toBe(200);
    const role = (await roleResponse.json()) as Envelope<{
      job: { id: string };
      opportunity: { id: string };
    }>;
    jobId = role.data?.job.id;
    opportunityId = role.data?.opportunity.id;
    expect(jobId).toBeTruthy();
    expect(opportunityId).toBeTruthy();
    await expect(page.getByRole('heading', { name: roleTitle })).toBeVisible();

    // This recorded AI result exists only in the isolated test database. The
    // journey still approves a real profile fact and uses the real editor,
    // approval route, PDF renderer, storage and download route.
    const [recordedResume] = await database
      .insert(resumeVersions)
      .values({
        userId: me.data.id,
        opportunityId: opportunityId!,
        content: {
          name: 'New workspace candidate',
          contact: 'candidate@example.test',
          sections: [
            {
              title: 'Selected project',
              bullets: [{ text: factText, fact_ids: [fact!.id] }],
            },
          ],
        },
        version: 1,
        promptVersion: 'recorded-browser-fixture.v1',
        model: 'recorded-fixture',
      })
      .returning({ id: resumeVersions.id });
    resumeId = recordedResume.id;

    await page.goto(`/workspace/roles/${opportunityId}/resume`);
    await expect(
      page.getByRole('heading', {
        name: `Prepare: ${roleTitle} at ${company}`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTitle('Tailored CV PDF preview')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('textbox', { name: 'CV line' })).toHaveValue(
      factText,
    );
    await expect(
      page.getByRole('group', { name: 'Supporting approved facts' }),
    ).toContainText(factText);
    await page
      .getByLabel(
        'I checked my name and contact details, and that each CV line matches its supporting facts.',
      )
      .check();
    await page.getByRole('button', { name: 'Approve & download PDF' }).click();
    await expect(page.getByRole('button', { name: 'CV approved' })).toBeVisible(
      {
        timeout: 15_000,
      },
    );

    const resumeResponse = await page.request.get(
      `/api/v1/opportunities/${opportunityId}/resumes`,
    );
    const resumeList = (await resumeResponse.json()) as Envelope<
      Array<{ id: string; approvedAt: string | null; pdfFileId: string | null }>
    >;
    const approvedResume = resumeList.data?.[0];
    resumeId = approvedResume?.id;
    expect(approvedResume?.approvedAt).toBeTruthy();
    expect(approvedResume?.pdfFileId).toBeTruthy();

    const pdfResponse = await page.request.get(
      `/api/v1/files/${approvedResume!.pdfFileId}`,
    );
    expect(pdfResponse.status()).toBe(200);
    expect(pdfResponse.headers()['content-type']).toContain('application/pdf');
    expect(
      new TextDecoder().decode((await pdfResponse.body()).subarray(0, 5)),
    ).toBe('%PDF-');
  } finally {
    await session.close();
    if (resumeId) {
      const [resume] = await database
        .select({ pdfFileId: resumeVersions.pdfFileId })
        .from(resumeVersions)
        .where(eq(resumeVersions.id, resumeId))
        .limit(1);
      if (resume?.pdfFileId) {
        const [file] = await database
          .select({ id: files.id, r2Key: files.r2Key })
          .from(files)
          .where(eq(files.id, resume.pdfFileId))
          .limit(1);
        if (file) {
          await testStorage.delete(file.r2Key).catch(() => undefined);
          await database.delete(files).where(eq(files.id, file.id));
        }
      }
      await database
        .delete(resumeVersions)
        .where(eq(resumeVersions.id, resumeId));
    }
    if (jobId) await database.delete(jobs).where(eq(jobs.id, jobId));
    if (projectId)
      await database.delete(projects).where(eq(projects.id, projectId));
    await pool.end();
  }
});
