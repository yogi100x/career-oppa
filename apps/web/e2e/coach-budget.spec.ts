import { expect, test } from './fixtures';

test('shows low coach allowance and keeps overlong drafts until shortened', async ({
  page,
}) => {
  let remaining = 5;
  const response = (data: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
  await page.route('**/api/v1/coach/allowance', (route) =>
    route.fulfill(
      response({
        limit: 20,
        used: 20 - remaining,
        pending: 0,
        remaining,
        resetAt: '2026-10-17T12:00:00.000Z',
      }),
    ),
  );
  await page.route('**/api/v1/coach/messages', (route) =>
    route.fulfill(response([])),
  );
  await page.route('**/api/v1/coach/proposals', (route) =>
    route.fulfill(response([])),
  );
  await page.route('**/api/v1/opportunities', (route) =>
    route.fulfill(response([])),
  );

  await page.goto('/workspace/coach');
  await expect(
    page.getByText(
      '5 coach messages remaining. Slots renew over the next 24 hours.',
    ),
  ).toBeVisible();

  const composer = page.getByLabel('Talk it through');
  const send = page.getByRole('button', { name: 'Send' });
  const overlongDraft = 'x'.repeat(1001);
  await composer.fill(overlongDraft);
  await expect(composer).toHaveValue(overlongDraft);
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Please shorten your message to 1,000 characters',
    }),
  ).toBeVisible();
  await expect(send).toBeDisabled();

  await composer.fill('x'.repeat(1000));
  await expect(page.getByText('1,000 / 1,000 characters')).toBeVisible();
  await expect(send).toBeEnabled();

  remaining = 0;
  await page.reload();
  await expect(
    page.getByText(/Your next coach message slot opens around/),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'paste a job for review' }),
  ).toHaveAttribute('href', '/workspace?view=roles&add=1');
  await expect(
    page.getByRole('link', { name: 'collected matches' }),
  ).toHaveAttribute('href', '/workspace/discover');
  await expect(page.getByRole('link', { name: 'My roles' })).toHaveAttribute(
    'href',
    '/workspace?view=roles',
  );
});
