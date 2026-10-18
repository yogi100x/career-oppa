import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import { readVisibleRolePage } from '../../extension/src/read-page';

test('captures visible role text and opens the saved role with real sign-in', async ({
  page,
}) => {
  const marker = randomUUID();
  await page.goto('/workspace');
  await page.waitForFunction(() =>
    Boolean(
      (window as Window & { Clerk?: { session?: unknown } }).Clerk?.session,
    ),
  );
  const token = await page.evaluate(async () => {
    const clerkWindow = window as Window & {
      Clerk?: { session?: { getToken(): Promise<string | null> } };
    };
    return clerkWindow.Clerk?.session?.getToken();
  });
  expect(token).toBeTruthy();
  await page.setContent(
    '<header>Navigation must not be captured</header><main><h1>Junior developer</h1><p>Build accessible interfaces with TypeScript, review small changes with the team, and document practical decisions. Work with product colleagues to deliver useful software for customers.</p><p hidden>Hidden private text</p><textarea>Unsubmitted private form text</textarea></main>',
  );
  const captured = await page.evaluate(readVisibleRolePage);
  expect(captured.title).toBe('Junior developer');
  expect(captured.text).not.toContain('Navigation');
  expect(captured.text).not.toContain('Hidden private');
  expect(captured.text).not.toContain('Unsubmitted private');
  const origin = 'chrome-extension://efpojcicpmejmpjeeaekchonofonmbkm';
  const saved = await page.request.post('/api/v1/jobs/capture', {
    headers: { authorization: `Bearer ${token}`, origin },
    data: {
      title: `${captured.title} ${marker}`,
      company: 'Capture fixture',
      url: `https://example.com/jobs/${marker}`,
      text: captured.text,
    },
  });
  expect(saved.status()).toBe(200);
  expect(saved.headers()['access-control-allow-origin']).toBe(origin);
  const body = (await saved.json()) as {
    data: { opportunity: { id: string }; job: { source: string } };
  };
  expect(body.data.job.source).toBe('extension');
  await page.goto(`/workspace/roles/${body.data.opportunity.id}`);
  await expect(
    page.getByRole('heading', { name: `${captured.title} ${marker}` }),
  ).toBeVisible();
  await expect(
    page.getByText(`${captured.title} ${marker}`, { exact: true }),
  ).toBeVisible();
  const deniedOrigin = await page.request.fetch('/api/v1/jobs/capture', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://untrusted.example',
      'access-control-request-method': 'POST',
    },
  });
  expect(deniedOrigin.status()).toBe(403);
});
