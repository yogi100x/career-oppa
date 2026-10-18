import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function returnToWorkspaceFromAuthRoute(
  page: Page,
  route: '/sign-in' | '/sign-up',
) {
  await page.goto(`${route}?redirect_url=http%3A%2F%2Flocalhost%3A3001%2F`);
  await expect(
    page.getByRole('heading', {
      name: /Your next step starts here\.|Find a role that fits you\./,
    }),
  ).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe('/workspace');
}

test('an active Clerk session returns to the workspace from sign-in', async ({
  page,
}) => {
  await returnToWorkspaceFromAuthRoute(page, '/sign-in');
});

test('an active Clerk session returns to the workspace from sign-up', async ({
  page,
}) => {
  await returnToWorkspaceFromAuthRoute(page, '/sign-up');
});
