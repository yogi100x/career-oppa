import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, test } from './fixtures';
import {
  fitReviews,
  getDatabase,
  reminders,
  rateLimits,
  resumeVersions,
} from '@career-workspace/db';

test('signed-in visitors to the landing page are sent to the workspace', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/workspace$/);
});

test('home shows real roles and follow-ups; documents opens the latest CV', async ({
  page,
}) => {
  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.ok()).toBeTruthy();
  const meBody = await meResponse.json();
  const userId = meBody.data.id as string;
  const unique = randomUUID().slice(0, 8);
  const title = `Dashboard role ${unique}`;
  const followup = `Follow up with ${unique}`;
  const roleResponse = await page.request.post('/api/v1/jobs', {
    data: {
      title,
      company: 'Dashboard Studio',
      text: 'This is a real test role description for the authenticated dashboard. It includes enough detail for the saved role flow to accept the content and show the user a real opportunity in their workspace.',
    },
  });
  expect(roleResponse.ok()).toBeTruthy();
  const roleBody = await roleResponse.json();
  const opportunityId = roleBody.data.opportunity.id as string;

  const database = getDatabase();
  const content = {
    name: 'Workspace test user',
    contact: 'test@example.invalid',
    sections: [
      {
        title: 'Experience',
        bullets: [{ text: 'Built a test project.', fact_ids: [] }],
      },
    ],
  };
  await database.insert(resumeVersions).values([
    { userId, opportunityId, content, version: 1 },
    { userId, opportunityId, content, version: 2 },
  ]);
  await database.insert(reminders).values({
    userId,
    opportunityId,
    title: followup,
    status: 'pending',
    dueAt: new Date('2020-01-01T09:00:00Z'),
  });

  await page.goto('/workspace');
  await expect(
    page.getByRole('heading', { name: 'Your next step starts here.' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: followup })).toBeVisible();
  await page.getByRole('button', { name: 'Open follow-up →' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspace/roles/${opportunityId}$`),
  );
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.goto('/workspace');
  await page
    .getByText('Follow-ups and application check-ins', { exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Follow-ups' })).toBeVisible();
  await expect(page.getByRole('heading', { name: followup })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Follow-ups' }).getByText(followup),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Roles', exact: true })
    .click();
  await expect(
    page.getByRole('row', { name: new RegExp(title) }),
  ).toContainText('—');
  await page
    .getByRole('button', { name: `Open ${title} at Dashboard Studio` })
    .click();
  await expect(page).toHaveURL(/\/workspace\?view=roles$/);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: '← All roles' }).click();
  await expect(page).toHaveURL(/\/workspace\?view=roles$/);
  await expect(page.getByRole('heading', { name: 'My roles' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Documents' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'My documents' }),
  ).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toContainText('Draft · v2');
  await expect(row.getByRole('link', { name: 'Edit CV' })).toHaveAttribute(
    'href',
    `/workspace/roles/${opportunityId}/resume`,
  );
  await expect(row).toHaveCount(1);
});

test('roles can be searched by location and filtered by status and fit review', async ({
  page,
}) => {
  const meBody = await (await page.request.get('/api/v1/me')).json();
  const userId = meBody.data.id as string;
  const unique = randomUUID().slice(0, 8);
  // This filter test shares an identity with earlier tests. Reset only its
  // test-user save counter so fixture creation does not inherit their quota.
  await getDatabase()
    .delete(rateLimits)
    .where(
      and(eq(rateLimits.userId, userId), eq(rateLimits.actionKey, 'save_role')),
    );
  const reviewedTitle = `Reviewed role ${unique}`;
  const unreviewedTitle = `Unreviewed role ${unique}`;
  const createRole = (title: string, location: string) =>
    page.request.post('/api/v1/jobs', {
      data: {
        title,
        company: `Filter Studio ${unique}`,
        location,
        // Repeated text returns the existing role, so each role gets its own.
        text: `A complete test description for the ${title} position with enough detail to be saved and reviewed in the Career Workspace. The role includes collaboration, communication and delivery responsibilities.`,
      },
    });
  const reviewedResponse = await createRole(reviewedTitle, `London ${unique}`);
  const unreviewedResponse = await createRole(
    unreviewedTitle,
    `Remote ${unique}`,
  );
  expect(reviewedResponse.ok()).toBeTruthy();
  expect(unreviewedResponse.ok()).toBeTruthy();
  const reviewedRole = (await reviewedResponse.json()).data;
  const unreviewedRole = (await unreviewedResponse.json()).data;

  const statusResponse = await page.request.patch(
    `/api/v1/opportunities/${reviewedRole.opportunity.id}`,
    { data: { status: 'applied' } },
  );
  expect(statusResponse.ok()).toBeTruthy();
  const database = getDatabase();
  const [review] = await database
    .insert(fitReviews)
    .values({
      userId,
      opportunityId: reviewedRole.opportunity.id,
      verdict: 'Review fixture',
      strengths: [],
      gaps: [],
      unknowns: [],
      promptVersion: 'e2e-filter-fixture.v1',
      model: 'test-fixture',
    })
    .returning();

  try {
    await page.goto('/workspace?view=roles');
    const search = page.getByRole('searchbox', { name: 'Search roles' });
    await search.fill(unique);
    const reviewedRow = page.getByRole('row', {
      name: new RegExp(reviewedTitle),
    });
    const unreviewedRow = page.getByRole('row', {
      name: new RegExp(unreviewedTitle),
    });
    await expect(reviewedRow).toContainText(`London ${unique}`);
    await expect(unreviewedRow).toContainText(`Remote ${unique}`);

    await page.getByLabel('Fit review').selectOption('reviewed');
    await expect(reviewedRow).toBeVisible();
    await expect(unreviewedRow).toHaveCount(0);

    await page.getByLabel('Status').selectOption('saved');
    await expect(reviewedRow).toHaveCount(0);
    await page.getByLabel('Status').selectOption('applied');
    await expect(reviewedRow).toBeVisible();

    await page.getByLabel('Fit review').selectOption('all');
    await page.getByLabel('Status').selectOption('all');
    await search.fill(`Remote ${unique}`);
    await expect(unreviewedRow).toBeVisible();
    await expect(reviewedRow).toHaveCount(0);
  } finally {
    await database.delete(fitReviews).where(eq(fitReviews.id, review.id));
  }
  expect(unreviewedRole.opportunity.id).toBeTruthy();
});

test('phone next-move card keeps the desktop action at 390px', async ({
  page,
}) => {
  await page.goto('/workspace');
  const card = page.locator('section').filter({
    has: page.getByText('Your next useful step', { exact: true }),
  });
  const button = card.getByRole('button');
  await expect(button).toBeEnabled();
  const action = await button.innerText();
  const title = await card.getByRole('heading').innerText();
  const navigation = page.waitForURL(
    (url) => url.pathname !== '/workspace' || url.search !== '',
  );
  await button.click();
  await navigation;
  const destination = page.url();
  await page.goto('/workspace');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading')).toHaveText(title);
  await expect(button).toHaveText(action);
  await expect(card.getByRole('img')).toBeHidden();
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(card).toHaveCSS('background-color', 'rgb(255, 180, 237)');
  const heading = card.getByRole('heading');
  await expect(heading).toHaveCSS('white-space', 'nowrap');
  const roles = page.getByRole('heading', {
    name: 'Open roles for you',
    exact: true,
  });
  await expect(roles).toBeVisible();
  expect((await card.boundingBox())!.y).toBeLessThan(
    (await roles.boundingBox())!.y,
  );
  await button.click();
  await expect(page).toHaveURL(destination);
});
