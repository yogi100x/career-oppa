import { spawn } from 'node:child_process';
import { and, eq, sql } from 'drizzle-orm';
import {
  files,
  getDatabase,
  profileFacts,
  rateLimits,
  tasks,
  users,
} from '@career-workspace/db';
import { test, expect, createRefreshedBrowserContext } from './fixtures';
import { resolve } from 'node:path';

async function recordedExtraction(userId: string, taskId: string) {
  return new Promise<void>((resolveResult, reject) => {
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
          JSON.parse(output);
          resolveResult();
        } catch (cause) {
          reject(cause);
        }
      }
    });
    child.stdin.end(JSON.stringify({ userId, taskId }));
  });
}

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
        sql`${tasks.userId} = ${userId} AND ${tasks.kind} = 'cv_extract' AND ${tasks.input}->>'fileId' = ${file.id}`,
      );
    await database
      .delete(profileFacts)
      .where(eq(profileFacts.sourceFileId, file.id));
    await database.delete(files).where(eq(files.id, file.id));
  }
}

test('a failed saved CV can be read again, reviewed from CV-only setup, and returned to its role', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
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
  const me = await (await page.request.get('/api/v1/me')).json();
  const userId = me.data.id as string;
  const returnRole = '11111111-1111-4111-8111-111111111111';
  let releaseTaskReads = () => {};
  let holdTaskReads = false;

  await clearCvUploads(database, userId);
  await database.delete(profileFacts).where(eq(profileFacts.userId, userId));
  // Repeated local runs must not trip the hourly Read again limit.
  await database
    .delete(rateLimits)
    .where(
      and(
        eq(rateLimits.userId, userId),
        eq(rateLimits.actionKey, 'cv_read_again'),
      ),
    );
  await database
    .update(users)
    .set({ targetRoles: [] })
    .where(eq(users.id, userId));
  try {
    await page.goto('/workspace');
    await expect(
      page.getByRole('button', { name: 'Add your CV', exact: true }),
    ).toBeVisible();

    const uploadResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/profile/cv') &&
        response.request().method() === 'POST',
    );
    const chooser = page.waitForEvent('filechooser');
    await page
      .getByRole('button', { name: 'Add your CV', exact: true })
      .click();
    await (
      await chooser
    ).setFiles(resolve('packages/adapters/src/fixtures/sample-cv.docx'));
    const uploaded = await uploadResponse;
    expect(uploaded.status()).toBe(201);
    const uploadBody = await uploaded.json();
    const fileId = uploadBody.data.file.id as string;
    const initialTaskId = uploadBody.data.task.id as string;

    await expect
      .poll(
        async () => {
          const [task] = await database
            .select({ status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, initialTaskId));
          return task?.status;
        },
        { timeout: 30_000 },
      )
      .toBe('failed');
    await expect(
      page.getByText(/Your CV is saved but we could not read it/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Read it again' }),
    ).toBeVisible();
    await expect(page.getByText(/Saved:.*sample-cv\.docx/)).toBeVisible();

    let release!: () => void;
    const taskReadGate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    releaseTaskReads = release;
    await page.route('**/api/v1/tasks/*', async (route) => {
      if (holdTaskReads) await taskReadGate;
      await route.continue();
    });
    holdTaskReads = true;
    const retryResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/profile/cv/${fileId}/retry`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Read it again' }).click();
    const retried = await retryResponse;
    expect(retried.ok()).toBe(true);
    const retryBody = await retried.json();
    expect(retryBody.data.file.id).toBe(fileId);
    const retryTaskId = retryBody.data.task.id as string;

    await expect
      .poll(
        async () => {
          const [task] = await database
            .select({ status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, retryTaskId));
          return task?.status;
        },
        { timeout: 30_000 },
      )
      .toBe('failed');
    await recordedExtraction(userId, retryTaskId);
    holdTaskReads = false;
    releaseTaskReads();

    const uploadedFiles = await database
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.userId, userId), eq(files.kind, 'cv_upload')));
    expect(uploadedFiles.map(({ id }) => id)).toContain(fileId);
    expect(
      await database
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.userId, userId), eq(files.kind, 'cv_upload'))),
    ).toHaveLength(1);

    // This journey can cross Clerk's short development-session lifetime.
    // Refresh the real browser session before checking a new server-rendered route.
    const sessionToken = await page.evaluate(async () => {
      const clerk = (
        window as Window & {
          Clerk?: {
            session?: {
              getToken(options: { skipCache: boolean }): Promise<string | null>;
            };
          };
        }
      ).Clerk;
      return clerk?.session?.getToken({ skipCache: true });
    });
    if (!sessionToken)
      throw new Error('Could not refresh the signed-in test session.');
    await page
      .context()
      .addCookies([{ name: '__session', value: sessionToken, url: baseURL! }]);
    await page.goto(`/workspace?setup=cv&returnRole=${returnRole}`);
    await expect(
      page.getByText('Your CV is saved. Confirm the facts we found.'),
    ).toBeVisible();
    await expect(page.getByText(/Saved:.*sample-cv\.docx/)).toBeVisible();
    await page.getByText('Review details (2 facts)', { exact: true }).click();
    const skill = page.getByRole('checkbox', { name: 'Include this skill' });
    await expect(skill).toBeChecked();
    await skill.uncheck();
    await page
      .getByRole('checkbox', { name: 'Include this experience' })
      .check();
    await page.getByRole('button', { name: 'Looks right, continue' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/workspace/roles/${returnRole}\\?review=1`),
    );
  } finally {
    holdTaskReads = false;
    releaseTaskReads();
    await clearCvUploads(database, userId);
    await database.delete(profileFacts).where(eq(profileFacts.userId, userId));
    await database
      .update(users)
      .set({ targetRoles: [] })
      .where(eq(users.id, userId));
    await session.close();
  }
});
