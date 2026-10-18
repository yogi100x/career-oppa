import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { getDatabase, resumeVersions } from '@career-workspace/db';
import { expect, test } from './fixtures';

test('role preferences save and remain selected after reload', async ({
  page,
}, testInfo) => {
  const marker = randomUUID().slice(0, 8);
  await page.goto('/workspace/profile');
  const preferences = page.getByRole('region', {
    name: 'Your role preferences',
  });
  await expect(
    preferences.getByRole('heading', { name: 'Your role preferences' }),
  ).toBeVisible();
  await preferences
    .getByLabel('Target roles, one per line')
    .fill(`Product designer ${marker}\nUX researcher ${marker}`);
  await preferences.getByLabel('Preferred location').fill(`London ${marker}`);
  await preferences.getByLabel('Work arrangement').selectOption('remote');
  await preferences.getByLabel('Default CV page size').selectOption('LETTER');
  await preferences.getByRole('button', { name: 'Save preferences' }).click();
  await expect(preferences.getByRole('status')).toContainText(
    'Preferences saved.',
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath('profile-preferences-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('profile-preferences-phone.png'),
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 320, height: 780 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  await page.reload();
  const reloaded = page.getByRole('region', { name: 'Your role preferences' });
  await expect(reloaded.getByLabel('Target roles, one per line')).toHaveValue(
    `Product designer ${marker}\nUX researcher ${marker}`,
  );
  await expect(reloaded.getByLabel('Preferred location')).toHaveValue(
    `London ${marker}`,
  );
  await expect(reloaded.getByLabel('Work arrangement')).toHaveValue('remote');
  await expect(reloaded.getByLabel('Default CV page size')).toHaveValue(
    'LETTER',
  );

  const roleResponse = await page.request.post('/api/v1/jobs', {
    data: {
      title: 'Letter preference check',
      company: 'Page Size Studio',
      text: 'A complete test role description with enough detail to open an application. The role includes collaboration, communication and delivery responsibilities for the successful candidate.',
    },
  });
  expect(roleResponse.ok()).toBeTruthy();
  const roleBody = await roleResponse.json();
  const meBody = await (await page.request.get('/api/v1/me')).json();
  // Test-only draft: core integration tests separately prove the first-save default.
  const preferencesBody = await (
    await page.request.get('/api/v1/profile/preferences')
  ).json();
  await getDatabase()
    .insert(resumeVersions)
    .values({
      userId: meBody.data.id,
      opportunityId: roleBody.data.opportunity.id,
      content: {
        name: 'Preference test candidate',
        contact: '',
        sections: [
          {
            title: 'Experience',
            bullets: [{ text: 'Preference test draft claim.', fact_ids: [] }],
          },
        ],
      },
      version: 1,
      pageSize: preferencesBody.data.paperSize,
    });
  await page.goto(`/workspace/roles/${roleBody.data.opportunity.id}/resume`);
  await expect(page.getByLabel('Page size')).toHaveValue('LETTER');
});

test('documents lists the master CV and supports portfolio upload and download', async ({
  page,
}, testInfo) => {
  await page.goto('/workspace/profile');
  // The button enables only once the page's handlers have attached, so
  // choose the file again until it does (slow first load on a cold server).
  // Clear the input first: choosing the same file twice fires no change event.
  await expect(async () => {
    const input = page.getByLabel('Choose a CV file');
    await input.setInputFiles([]);
    await input.setInputFiles(
      resolve('packages/adapters/src/fixtures/sample-cv.docx'),
    );
    await expect(page.getByRole('button', { name: 'Upload CV' })).toBeEnabled({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/profile/cv') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Upload CV' }).click();
  expect((await uploadResponse).status()).toBe(201);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'AI fact extraction is not configured yet.' }),
  ).toBeVisible({ timeout: 20_000 });

  await page.goto('/workspace?view=documents');
  const masterRow = page.getByRole('row', { name: /sample-cv\.docx/ });
  await expect(masterRow).toContainText('Master CV');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath('documents-upload-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('documents-upload-phone.png'),
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 320, height: 780 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  const masterDownload = page.waitForEvent('download');
  await masterRow
    .getByRole('link', { name: 'Download sample-cv.docx' })
    .click();
  expect((await masterDownload).suggestedFilename()).toBe('sample-cv.docx');

  await page.getByLabel('Document type').selectOption('portfolio');
  await page
    .getByLabel('Document file')
    .setInputFiles(
      resolve('apps/web/public/demo/output/pdf/career-oppa-sample-cv.pdf'),
    );
  await page.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByRole('status')).toContainText('Document saved.');
  const portfolioRow = page.getByRole('row', {
    name: /career-oppa-sample-cv\.pdf/,
  });
  await expect(portfolioRow).toContainText('Portfolio');
  const portfolioDownload = page.waitForEvent('download');
  await portfolioRow
    .getByRole('link', { name: 'Download career-oppa-sample-cv.pdf' })
    .click();
  expect((await portfolioDownload).suggestedFilename()).toBe(
    'career-oppa-sample-cv.pdf',
  );
});
