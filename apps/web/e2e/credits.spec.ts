import { expect, test } from './fixtures';

test('shows the signed-in user’s real credit balance, costs, packs and history', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.request.get('/api/v1/credits');
  expect(response.ok()).toBeTruthy();
  const { data } = await response.json();

  await page.goto('/workspace/credits');
  await expect(
    page.getByRole('heading', { name: 'Your credits' }),
  ).toBeVisible();
  await expect(
    page.getByLabel(`${data.available} credits available`),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'What actions cost' }),
  ).toBeVisible();
  await expect(page.getByText('Review a role')).toBeVisible();
  await expect(page.getByText('Draft a tailored CV')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Add credits' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Starter' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Job hunt' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Full season' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Credit history' }),
  ).toBeVisible();
  await expect(page.getByText('Monthly free credits').first()).toBeVisible();
  const checkoutConfigured = [
    process.env.DODO_PAYMENTS_API_KEY,
    process.env.DODO_PAYMENTS_RETURN_URL,
    process.env.DODO_PRODUCT_STARTER,
  ].every((value) => Boolean(value) && !value?.startsWith('REPLACE_WITH_'));
  if (!checkoutConfigured) {
    await page.getByRole('button', { name: 'Choose pack' }).first().click();
    await expect(
      page.getByText('Credit purchases are not set up in this environment yet.'),
    ).toBeVisible();
    const afterCheckoutFailure = await page.request.get('/api/v1/credits');
    const afterData = (await afterCheckoutFailure.json()).data;
    expect(afterData.available).toBe(data.available);
  }
  await page.screenshot({
    path: testInfo.outputPath('credits-desktop.png'),
    fullPage: true,
  });
  await page
    .getByRole('heading', { name: 'Add credits' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('credits-desktop-packs.png'),
    fullPage: true,
  });
  await page
    .getByRole('heading', { name: 'Credit history' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('credits-desktop-history.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('heading', { name: 'Add credits' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('credits-phone-packs.png'),
    fullPage: true,
  });
  await page
    .getByRole('heading', { name: 'Credit history' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('credits-phone.png'),
    fullPage: true,
  });
});
