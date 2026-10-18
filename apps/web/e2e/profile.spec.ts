import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';

test('review CV status, edit and reject facts, and manage a project', async ({
  page,
}) => {
  const marker = randomUUID();
  const projectTitle = `Campus food pantry ${marker}`;
  const firstClaim = `Coordinated volunteer shifts for weekly collections. ${marker}`;
  const editedClaim = `Organised volunteer shifts for weekly collections. ${marker}`;
  const secondClaim = `Tracked weekly donations and stock. ${marker}`;

  await page.goto('/workspace/profile');
  await expect(
    page.getByRole('heading', { name: 'Your profile' }),
  ).toBeVisible();
  await page
    .getByLabel('Choose a CV file')
    .setInputFiles(resolve('packages/adapters/src/fixtures/sample-cv.docx'));
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/profile/cv') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Upload CV' }).click();
  const upload = await uploadResponse;
  expect(upload.status()).toBe(201);
  const uploadBody = (await upload.json()) as {
    data: { task: { id: string } };
  };
  const taskId = uploadBody.data.task.id;

  await expect(page.getByRole('status')).toContainText(
    'Your CV was saved and its text was read. AI fact extraction is not configured yet.',
    { timeout: 20_000 },
  );
  const taskResult = (await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/tasks/${id}`);
    return response.json();
  }, taskId)) as {
    data: {
      status: string;
      error: string | null;
      output: { text?: string; textLength?: number } | null;
    };
  };
  expect(taskResult.data.status).toBe('failed');
  expect(taskResult.data.error).toBe('AI_NOT_CONFIGURED');
  expect(taskResult.data.output?.text).toBeUndefined();
  expect(taskResult.data.output?.textLength).toBeGreaterThan(0);

  await page.getByLabel('Project name').fill(projectTitle);
  await page
    .getByLabel('What did you work on?')
    .fill('Helped organise weekly food collections.');
  await page
    .getByLabel('Links, one per line')
    .fill('https://example.org/pantry');
  await page.getByLabel('Add a claim for review').fill(firstClaim);
  await page.getByRole('button', { name: 'Add project' }).click();

  const project = page.getByRole('article').filter({ hasText: projectTitle });
  await expect(project).toContainText(firstClaim);
  await expect(project).toContainText('proposed');
  const factsRegion = page.getByRole('region', {
    name: 'Facts about your experience',
  });
  const firstClaimFact = factsRegion
    .getByRole('article')
    .filter({ hasText: firstClaim });
  await firstClaimFact.getByRole('button', { name: 'Edit' }).click();
  await firstClaimFact.getByLabel('Edit this fact').fill(editedClaim);
  await page.getByRole('button', { name: 'Save edit' }).click();
  const editedFact = factsRegion
    .getByRole('article')
    .filter({ hasText: editedClaim });
  await expect(editedFact).toContainText(editedClaim);
  await editedFact.getByRole('button', { name: 'Approve' }).click();
  await expect(editedFact).toContainText('approved');

  await project.getByRole('button', { name: 'Edit project' }).click();
  await page.getByLabel('Add a claim for review').fill(secondClaim);
  await page.getByRole('button', { name: 'Save project' }).click();
  await expect(project).toContainText(secondClaim);
  await expect(project).toContainText('proposed');
  const secondClaimFact = factsRegion
    .getByRole('article')
    .filter({ hasText: 'From project' })
    .filter({ hasText: secondClaim });
  await secondClaimFact.getByRole('button', { name: 'Reject' }).click();
  await expect(secondClaimFact).toContainText('rejected');

  await project.getByRole('button', { name: 'Delete project' }).click();
  await project.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(project).toHaveCount(0);
  await expect(page.getByText(editedClaim, { exact: true })).toHaveCount(0);
  await expect(page.getByText(secondClaim, { exact: true })).toHaveCount(0);
});
