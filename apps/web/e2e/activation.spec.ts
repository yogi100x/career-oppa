import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import {
  files,
  getDatabase,
  profileFacts,
  publicJobDiscoveryJobs,
  publicJobDiscoverySources,
  tasks,
  users,
} from '@career-workspace/db';
import { test, expect, createRefreshedBrowserContext } from './fixtures';

async function clearCvUploads(
  database: ReturnType<typeof getDatabase>,
  userId: string,
) {
  const uploads = await database
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.userId, userId), eq(files.kind, 'cv_upload')));
  for (const file of uploads) {
    await database
      .delete(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.kind, 'cv_extract'),
          sql`${tasks.input}->>'fileId' = ${file.id}`,
        ),
      );
    await database
      .delete(profileFacts)
      .where(eq(profileFacts.sourceFileId, file.id));
    await database.delete(files).where(eq(files.id, file.id));
  }
}

async function recordedExtraction(
  userId: string,
  taskId: string,
): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/web/e2e/activation-provider-fixture.mts'],
      { env: process.env },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      if (code) reject(new Error('Recorded extraction fixture failed.'));
      else {
        try {
          resolveResult(JSON.parse(output));
        } catch (cause) {
          reject(cause);
        }
      }
    });
    child.stdin.end(JSON.stringify({ userId, taskId }));
  });
}

for (const width of [390, 1280])
  for (const path of ['target', 'cv'] as const) {
    test(`first useful matches from ${path} at ${width}px`, async ({
      browser,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      if (
        new URL(process.env.DATABASE_TEST_URL!).pathname !==
        '/career_workspace_test'
      )
        throw new Error('Use career_workspace_test only.');
      const database = getDatabase();
      const session = await createRefreshedBrowserContext(
        browser,
        resolve('apps/web/e2e/.auth/user-d.json'),
        baseURL!,
      );
      const page = session.page;
      await page.setViewportSize({ width, height: 900 });
      const me = await (await page.request.get('/api/v1/me')).json();
      const userId = me.data.id as string;
      await clearCvUploads(database, userId);
      const marker = randomUUID();
      const sourceId = `greenhouse:activation-${marker}`;
      const title =
        path === 'target'
          ? 'DevOps engineer'
          : 'Volunteer scheduling coordinator';
      const url = `https://boards.greenhouse.io/activation/jobs/${marker}`;
      let uploadedFileId: string | undefined;
      await database.insert(publicJobDiscoverySources).values({
        id: sourceId,
        provider: 'greenhouse',
        board: `activation-${marker}`,
        company: 'Recorded open roles',
      });
      await database.insert(publicJobDiscoveryJobs).values({
        sourceId,
        externalId: marker,
        canonicalUrl: url,
        canonicalUrlHash: createHash('sha256').update(url).digest('hex'),
        title,
        company: 'Recorded open roles',
        location: 'Remote',
        workMode: 'remote',
        url,
        text: `${title}. Responsibilities include volunteer scheduling, maintaining reliable systems, planning delivery with a team, and communicating clearly with colleagues.`,
      });
      try {
        await page.goto('/workspace');
        await expect(
          page.getByRole('heading', { name: 'Find a role that fits you.' }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Add your CV', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Choose a role you want' }),
        ).toBeVisible();
        await expect(page.getByRole('complementary')).toHaveCount(0);
        await mkdir('docs/ux-audit', { recursive: true });
        await expect(
          page.getByRole('button', { name: 'Open user menu' }),
        ).toBeVisible();
        await page.screenshot({
          path: `docs/ux-audit/after-${width}-01-choice.png`,
        });
        if (path === 'target') {
          await page
            .getByRole('button', { name: 'Choose a role you want' })
            .click();
          await page
            .getByLabel('Target role', { exact: true })
            .fill('DevOps engineer');
          await page.getByRole('button', { name: 'Show my matches' }).click();
        } else {
          // Real upload handler/storage/task. Only the AI result is recorded in this test.
          const uploadReply = page.waitForResponse(
            (response) =>
              response.url().endsWith('/api/v1/profile/cv') &&
              response.request().method() === 'POST',
          );
          const recordedDone = uploadReply.then(async (response) => {
            expect(response.status()).toBe(201);
            const body = await response.json();
            const taskId = body.data.task.id as string;
            uploadedFileId = body.data.file.id as string;
            await expect
              .poll(
                async () => {
                  const [task] = await database
                    .select()
                    .from(tasks)
                    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
                  return task.status;
                },
                { timeout: 30_000 },
              )
              .toBe('failed');
            await recordedExtraction(userId, taskId);
          });
          // Delay progress reads until the test-only provider has finished; the real GET still runs.
          await page.route('**/api/v1/tasks/*', async (route) => {
            await recordedDone;
            await route.continue();
          });
          await page.route('**/api/v1/profile/cv?*', async (route) => {
            // The upload flow also asks for file-specific state immediately;
            // let that real request run after the recorded extraction finishes.
            if (new URL(route.request().url()).searchParams.has('fileId'))
              await recordedDone;
            await route.continue();
          });
          const chooser = page.waitForEvent('filechooser');
          await page
            .getByRole('button', { name: 'Add your CV', exact: true })
            .click();
          await (
            await chooser
          ).setFiles(resolve('packages/adapters/src/fixtures/sample-cv.docx'));
          await recordedDone;
          await expect(
            page.getByRole('heading', { name: 'Does this sound like you?' }),
          ).toBeVisible();
          await page.reload();
          await expect(
            page.getByText('Your CV is saved. Confirm the facts we found.'),
          ).toBeVisible();
          await expect(page.getByText(/Saved:.*sample-cv\.docx/)).toBeVisible();
          const before = await database
            .select()
            .from(profileFacts)
            .where(eq(profileFacts.userId, userId));
          expect(before.every((f) => f.status === 'proposed')).toBe(true);
          await expect(
            page.getByText('By choosing “Looks right, continue”', {
              exact: false,
            }),
          ).toContainText('2 selected facts');
          await page
            .getByText('Review details (2 facts)', { exact: true })
            .click();
          await expect(
            page.getByRole('checkbox', { name: 'Include this experience' }),
          ).toBeChecked();
          await expect(
            page.getByRole('checkbox', { name: 'Include this skill' }),
          ).toBeChecked();
          await page
            .getByRole('checkbox', { name: 'Include this skill' })
            .uncheck();
          await page
            .getByRole('checkbox', { name: 'Include this experience' })
            .uncheck();
          await expect(
            page.getByRole('button', { name: 'Looks right, continue' }),
          ).toBeDisabled();
          await expect(
            page.getByText('Pick at least one fact, or add one in Profile.'),
          ).toBeVisible();
          await page
            .getByRole('checkbox', { name: 'Include this experience' })
            .check();
          await page
            .getByText('Review details (2 facts)', { exact: true })
            .click();
          await page.screenshot({
            path: `docs/ux-audit/after-${width}-02-confirm-facts.png`,
          });
          await page
            .getByRole('button', { name: 'Looks right, continue' })
            .click();
          await expect
            .poll(async () => {
              const approved = await database
                .select()
                .from(profileFacts)
                .where(
                  and(
                    eq(profileFacts.userId, userId),
                    eq(profileFacts.status, 'approved'),
                  ),
                );
              return approved.map((f) => f.text);
            })
            .toEqual(['Volunteer scheduling']);
        }
        const matches = page.getByRole('region', {
          name: 'Open roles for you',
        });
        await expect(
          matches.getByRole('heading', { name: title, exact: true }),
        ).toBeVisible();
        await expect(
          matches.getByText(/Why this matches:/).first(),
        ).toBeVisible();
        expect(await matches.getByRole('listitem').count()).toBeLessThanOrEqual(
          5,
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        if (path === 'target') {
          await expect(matches).toContainText('Matched to the role you want');
          expect(
            await database
              .select()
              .from(profileFacts)
              .where(eq(profileFacts.userId, userId)),
          ).toHaveLength(0);
        }
        await page.screenshot({
          path: `docs/ux-audit/after-${width}-${path}-matches.png`,
        });
        const lastMatch = matches.getByRole('listitem').last();
        await lastMatch
          .getByRole('button', { name: 'Save role', exact: true })
          .scrollIntoViewIfNeeded();
        await expect(
          lastMatch.getByRole('button', { name: 'Save role', exact: true }),
        ).toBeInViewport();
        const credits = await (
          await page.request.get('/api/v1/credits')
        ).json();
        expect(credits.data.firstReviewFree).toBe(true);
        await matches
          .getByText('Update collected roles', { exact: true })
          .click();
        // Keep the shared pool refresh recorded while checking the real feed and navigation.
        await page.route('**/api/v1/discovery/refresh', (route) =>
          route.fulfill({
            status: 202,
            json: {
              data: {
                started: true,
                task: {
                  id: 'activation-recorded-refresh',
                  status: 'succeeded',
                },
              },
            },
          }),
        );
        await matches
          .getByRole('link', { name: 'See all matches and collection status' })
          .click();
        await expect(page).toHaveURL(`${baseURL}/workspace/discover`);
        await expect(
          page.getByRole('heading', { name: 'Find jobs' }),
        ).toBeVisible();
        await expect(
          page.getByRole('heading', { name: title, exact: true }),
        ).toBeVisible();
        await page.goto('/workspace');
        await expect(
          page.getByRole('region', { name: 'Open roles for you' }),
        ).toBeVisible();
        if (path === 'cv') {
          const savedStatus = await page.request.get('/api/v1/profile/cv');
          expect(savedStatus.ok()).toBe(true);
          expect((await savedStatus.json()).data.file.id).toBe(uploadedFileId);
          await page.goto('/workspace?view=documents');
          const uploadedCv = page
            .getByRole('row')
            .filter({ hasText: 'sample-cv.docx' });
          await expect(uploadedCv).toContainText('Ready to review (1 fact)');
        }
      } finally {
        await clearCvUploads(database, userId);
        await database
          .delete(profileFacts)
          .where(eq(profileFacts.userId, userId));
        await database
          .update(users)
          .set({ targetRoles: [] })
          .where(eq(users.id, userId));
        await database
          .delete(publicJobDiscoveryJobs)
          .where(eq(publicJobDiscoveryJobs.sourceId, sourceId));
        await database
          .delete(publicJobDiscoverySources)
          .where(eq(publicJobDiscoverySources.id, sourceId));
        await session.close();
      }
    });
  }
