import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  getDatabase,
  posts,
  profileFacts,
  projects,
} from '@career-workspace/db';
import { expect, test } from './fixtures';

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

test('reviewed project post can be edited, approved for copy and copied without publishing', async ({
  page,
}, testInfo) => {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== '/career_workspace_test'
  )
    throw new Error('Use DATABASE_TEST_URL with career_workspace_test.');
  process.env.DATABASE_URL = databaseUrl;
  const database = getDatabase();
  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.ok()).toBeTruthy();
  const me = (await meResponse.json()) as Envelope<{ id: string }>;
  const userId = me.data?.id;
  expect(userId).toBeTruthy();

  const suffix = randomUUID().slice(0, 8);
  const evidence = `Launched an accessible TypeScript tool for local students ${suffix}.`;
  const [project] = await database
    .insert(projects)
    .values({
      userId: userId!,
      title: `Post project ${suffix}`,
      summary: 'A recorded browser fixture for the post editor.',
    })
    .returning();
  const [fact] = await database
    .insert(profileFacts)
    .values({
      userId: userId!,
      projectId: project.id,
      kind: 'achievement',
      text: evidence,
      source: 'project',
      status: 'approved',
    })
    .returning();
  const [post] = await database
    .insert(posts)
    .values({
      userId: userId!,
      projectId: project.id,
      content: `First draft about an earlier project ${suffix}.`,
      factIds: [fact.id],
      promptVersion: 'recorded-browser-fixture.v1',
      model: 'recorded-browser-fixture',
    })
    .returning();

  try {
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/workspace/posts');
    await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Your drafts' }),
    ).toBeVisible();
    await expect(page.getByText(evidence)).toBeVisible();
    const edited = `I launched ${evidence} I am proud of the measurable work behind it.`;
    await page.getByRole('textbox', { name: 'Post text' }).fill(edited);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Draft changes saved.',
    );
    await page
      .getByRole('checkbox', {
        name: 'I reviewed the exact text and destination.',
      })
      .check();
    await page.getByRole('button', { name: 'Approve this exact post' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Exact text approved for copying. It has not been published.',
    );
    await page.getByRole('button', { name: 'Copy approved text' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Approved text copied. You can paste and publish it yourself.',
    );

    const savedResponse = await page.request.get(`/api/v1/posts/${post.id}`);
    const savedBody = (await savedResponse.json()) as Envelope<{
      status: string;
      approvedContent: string | null;
    }>;
    expect(savedBody.data).toMatchObject({
      status: 'copy_ready',
      approvedContent: edited,
    });
    const directory = testInfo.outputPath('screenshots');
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: testInfo.outputPath('screenshots/posts-approved-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath('screenshots/posts-approved-phone.png'),
      fullPage: true,
    });
  } finally {
    await database.delete(posts).where(eq(posts.id, post.id));
    await database.delete(profileFacts).where(eq(profileFacts.id, fact.id));
    await database.delete(projects).where(eq(projects.id, project.id));
  }
});
