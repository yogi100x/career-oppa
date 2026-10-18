import { expect, test } from './fixtures';

test('add a role, review its status, and request a fit review', async ({
  page,
}) => {
  await page.goto('/workspace');
  await expect(
    page.getByRole('heading', {
      name: /Your next step starts here\.|Find a role that fits you\./,
    }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Roles' })
    .click();
  await expect(page.getByRole('heading', { name: 'My roles' })).toBeVisible();

  const factResponse = await page.request.post('/api/v1/profile/facts', {
    data: {
      kind: 'skill',
      text: 'Built accessible web tools with TypeScript.',
    },
  });
  expect(factResponse.ok()).toBeTruthy();
  const factBody = (await factResponse.json()) as { data: { id: string } };
  const approval = await page.request.patch(
    `/api/v1/profile/facts/${factBody.data.id}`,
    {
      data: { status: 'approved' },
    },
  );
  expect(approval.ok()).toBeTruthy();
  // RolesPanel reads fact eligibility when it mounts; reload after the API
  // setup so this test exercises the approved-fact path.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My roles' })).toBeVisible();
  const creditsResponse = await page.request.get('/api/v1/credits');
  expect(creditsResponse.ok()).toBeTruthy();
  const { firstReviewFree } = (await creditsResponse.json()).data as {
    firstReviewFree: boolean;
  };

  await page.getByRole('button', { name: 'Add a role' }).click();
  await page
    .getByRole('textbox', { name: 'Job title', exact: true })
    .fill('Frontend engineer');
  await page
    .getByRole('textbox', { name: 'Company', exact: true })
    .fill('Example Studio');
  await page.getByLabel('Location (optional)').fill('London');
  await page
    .getByLabel('Or paste the role description')
    .fill(
      'We are looking for an engineer to build accessible web products with a small product team. You will write maintainable TypeScript, work with designers, review code, improve performance, and support customer facing features from planning through release.',
    );
  await page.getByRole('button', { name: 'Save role' }).click();

  await expect(
    page.getByRole('heading', { name: 'Frontend engineer' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Prepare this application' }),
  ).toBeVisible();
  await expect(page.getByText('London', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Progress' })).toBeVisible();
  await page.getByLabel('Current status').selectOption('reviewed');
  await expect(page.getByText('Status updated.')).toBeVisible();

  await page.getByRole('button', { name: 'Talk to Oppa' }).click();
  const coachPanel = page.getByRole('complementary', {
    name: 'Talk to Oppa',
  });
  await expect(coachPanel).toBeVisible();
  await expect(coachPanel).toContainText('Frontend engineer');
  const coachResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/coach/chat') &&
      response.request().method() === 'POST',
  );
  await page.getByLabel('Talk it through').fill('How should I follow up?');
  await page.getByRole('button', { name: 'Send' }).click();
  const coachReply = await coachResponse;
  expect(coachReply.status()).toBe(503);
  await expect(
    page.getByText('Your coach is not connected to AI yet.'),
  ).toBeVisible();

  const fitResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/fit-review') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', {
      name: firstReviewFree
        ? 'Review fit · free first review'
        : 'Review fit · 1 credit',
    })
    .click();
  const response = await fitResponse;
  if (response.status() === 503) {
    await expect(page.getByText(/AI reviews are not configured/)).toContainText(
      'credits have not been charged',
    );
  } else {
    expect(response.ok()).toBeTruthy();
    await expect(page.getByText('Fit review saved.')).toBeVisible();
  }
  await expect(page.getByText(/score out of 10/i)).toHaveCount(0);
});
