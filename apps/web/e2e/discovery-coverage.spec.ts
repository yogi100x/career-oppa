import { expect, test } from './fixtures';

type Feed = {
  profileReady: boolean;
  targetRoles: string[];
  matches: unknown[];
  sources: unknown[];
  totalActiveJobs: number;
  updatedAt: string | null;
};

function feed(totalActiveJobs: number, targetRoles = ['DevOps engineer']): Feed {
  return {
    profileReady: true,
    targetRoles,
    matches: [],
    sources: [],
    totalActiveJobs,
    updatedAt: null,
  };
}

function targetOnlyFeed(): Feed {
  return {
    profileReady: false,
    targetRoles: ['DevOps engineer'],
    totalActiveJobs: 60,
    updatedAt: null,
    sources: [],
    matches: [
      {
        job: {
          id: '00000000-0000-4000-8000-000000000001',
          sourceId: 'greenhouse:example',
          provider: 'greenhouse',
          externalId: 'target-only-fixture',
          title: 'DevOps Engineer',
          company: 'Recorded fixture company',
          location: 'Remote',
          workMode: 'remote',
          url: 'https://boards.greenhouse.io/example/jobs/1',
          text: 'DevOps engineering role fixture.',
          postedAt: null,
          firstSeenAt: '2026-10-15T10:00:00.000Z',
          lastSeenAt: '2026-10-15T10:00:00.000Z',
          active: true,
        },
        matchedTerms: ['devops'],
        factIds: [],
        reasons: ['Matches target role: DevOps engineer'],
        savedOpportunityId: null,
      },
    ],
  };
}

async function openDiscover(page: import('@playwright/test').Page) {
  await page.goto('/workspace/discover');
  await expect(
    page.getByRole('heading', { name: 'Find jobs' }),
  ).toBeVisible();
}

async function expectNoHorizontalOverflow(
  page: import('@playwright/test').Page,
  width: number,
) {
  const measured = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(measured.viewport).toBe(width);
  expect(measured.document).toBeLessThanOrEqual(width);
  expect(measured.body).toBeLessThanOrEqual(width);
}

test('thin pool auto-refreshes once and keeps its attempt across reloads', async ({
  page,
}) => {
  let getCount = 0;
  let postCount = 0;
  let requestKey = '';
  await page.route('**/api/v1/discovery', async (route) => {
    getCount += 1;
    await route.fulfill({ json: { data: feed(0) } });
  });
  await page.route('**/api/v1/discovery/refresh', async (route) => {
    postCount += 1;
    requestKey = route.request().headers()['idempotency-key'] ?? '';
    await route.fulfill({
      status: 202,
      json: {
        data: {
          started: true,
          task: { id: 'task-empty-pool', status: 'succeeded' },
        },
      },
    });
  });

  await openDiscover(page);
  await expect(
    page.getByRole('heading', { name: 'Collection finished' }),
  ).toBeVisible();
  expect(postCount).toBe(1);
  expect(requestKey).toBeTruthy();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Find jobs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  expect(postCount).toBe(1);
  expect(getCount).toBeGreaterThanOrEqual(2);
});

test('a rate-limited automatic refresh shows a fallback and Check again is read-only', async ({
  page,
}) => {
  let getCount = 0;
  let postCount = 0;
  await page.route('**/api/v1/discovery', async (route) => {
    getCount += 1;
    await route.fulfill({ json: { data: feed(0) } });
  });
  await page.route('**/api/v1/discovery/refresh', async (route) => {
    postCount += 1;
    await route.fulfill({
      status: 429,
      json: {
        error: {
          code: 'RATE_LIMITED',
          message: 'Wait 15 minutes before requesting another refresh.',
        },
      },
    });
  });

  await openDiscover(page);
  await expect(
    page.getByRole('alert').getByText(/Wait 15 minutes/),
  ).toBeVisible();
  await expect(page.getByText('Software engineer')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Paste a job instead' }),
  ).toHaveAttribute('href', '/workspace?view=roles');

  const getsBeforeCheck = getCount;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => getCount).toBeGreaterThan(getsBeforeCheck);
  expect(postCount).toBe(1);
});

test('no matches after collection offers broader target roles and paste-a-job path', async ({
  page,
}) => {
  let postCount = 0;
  await page.route('**/api/v1/discovery', async (route) => {
    await route.fulfill({ json: { data: feed(50) } });
  });
  await page.route('**/api/v1/discovery/refresh', async (route) => {
    postCount += 1;
    await route.fulfill({
      status: 202,
      json: {
        data: {
          started: true,
          task: { id: 'task-no-matches', status: 'succeeded' },
        },
      },
    });
  });

  await openDiscover(page);
  await expect(
    page.getByRole('heading', { name: 'Collection finished' }),
  ).toBeVisible();
  await expect(
    page.getByText('Try a broader target role:'),
  ).toBeVisible();
  await expect(page.getByText('Software engineer')).toBeVisible();
  await expect(page.getByText('Platform engineer')).toBeVisible();
  await expect(page.getByText('Cloud engineer')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Update your target roles' }),
  ).toHaveAttribute('href', '/workspace/profile');
  await expect(
    page.getByRole('link', { name: 'Paste a job instead' }),
  ).toBeVisible();
  expect(postCount).toBe(1);
});

test('marketing targets get broader marketing search suggestions', async ({
  page,
}) => {
  await page.route('**/api/v1/discovery', async (route) => {
    await route.fulfill({
      json: { data: feed(50, ['Marketing manager']) },
    });
  });
  await page.route('**/api/v1/discovery/refresh', async (route) => {
    await route.fulfill({
      status: 202,
      json: {
        data: {
          started: true,
          task: { id: 'task-marketing-no-matches', status: 'succeeded' },
        },
      },
    });
  });

  await openDiscover(page);
  await expect(
    page.getByRole('heading', { name: 'Collection finished' }),
  ).toBeVisible();
  await expect(page.getByText('Marketing associate')).toBeVisible();
  await expect(page.getByText('Marketing coordinator')).toBeVisible();
  await expect(page.getByText('Content assistant')).toBeVisible();
});

test('target-role matches stay visible before the user adds a CV', async ({
  page,
}) => {
  await page.route('**/api/v1/discovery', async (route) => {
    await route.fulfill({ json: { data: targetOnlyFeed() } });
  });

  await openDiscover(page);
  await expect(
    page.getByRole('heading', { name: 'Matched jobs' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'DevOps Engineer' }),
  ).toBeVisible();
  await expect(
    page.getByText(/Add a CV when you want a personal fit review/),
  ).toBeVisible();
});

test('board health summary distinguishes inactive and refused sources and loads the next page', async ({ page }, testInfo) => {
  const source = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    provider: 'greenhouse',
    company: `Company ${id}`,
    board: id,
    status: 'failed',
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null,
    activeJobCount: 0,
    ...overrides,
  });
  const sources = Array.from({ length: 50 }, (_, index) => source(`board-${index + 1}`));
  sources[0] = source('dead-board', { deadUntilAt: '2026-10-20T00:00:00.000Z', failureCount: 4 });
  sources[1] = source('refused-board', { error: 'SOURCE_REFUSED', nextRetryAt: '2026-10-17T00:00:00.000Z', failureCount: 2 });
  sources[2] = source('board-3', { error: 'SOURCE_UNAVAILABLE', nextRetryAt: '2026-10-17T00:00:00.000Z' });
  await page.route('**/api/v1/discovery', async route => {
    await route.fulfill({ json: { data: {
      ...feed(60),
      sources,
      sourceTotal: 51,
      collection: {
        catalogBoards: 15862,
        verifiedBoards: 1200,
        deadBoards: 12,
        refusedBoards: 7,
        datasetFetchedAt: '2026-10-16T10:00:00.000Z',
        datasetError: null,
        cursor: 500,
      },
    } } });
  });
  await page.route('**/api/v1/discovery/refresh', async route => {
    await route.fulfill({ status: 202, json: { data: { started: true, task: { id: 'recorded-health-refresh', status: 'succeeded' } } } });
  });
  await page.route('**/api/v1/discovery/sources?offset=50', async route => {
    await route.fulfill({ json: { data: {
      sources: [source('board-51')],
      sourceTotal: 51,
      collection: null,
      nextOffset: null,
    } } });
  });

  await openDiscover(page);
  await expect(page.getByText('Board catalog: 15,862')).toBeVisible();
  await expect(page.getByText(/Dataset cache refreshed:/)).toBeVisible();
  await expect(page.getByText('Verified: 1,200 · Marked inactive: 12 · Temporarily refused: 7')).toBeVisible();
  await expect(page.getByText('Board marked inactive')).toBeVisible();
  await expect(page.getByText('Temporarily refused', { exact: true })).toBeVisible();
  await expect(page.locator('li').filter({ has: page.getByText('Company board-3', { exact: true }) }).getByText('Could not update', { exact: true })).toBeVisible();
  await expect(page.getByText('Showing 50 of 51 public boards.')).toBeVisible();
  const healthPanel = page.getByRole('complementary', { name: 'Job board checks' });
  await healthPanel.hover();
  await page.mouse.wheel(0, 20000);
  await expect(page.getByRole('button', { name: 'Load more board checks' })).toBeInViewport();
  await healthPanel.evaluate(element => { element.scrollTop = 0; });
  await page.getByRole('heading', { name: 'Collection finished' }).waitFor();
  await page.getByRole('complementary', { name: 'Job board checks' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: testInfo.outputPath('discovery-dataset-health-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Collection finished' }).waitFor();
  await page.getByRole('complementary', { name: 'Job board checks' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
  await expectNoHorizontalOverflow(page, 390);
  await expect.poll(async () => page.getByRole('complementary', { name: 'Job board checks' }).boundingBox().then(box => box?.y)).toBeLessThan(180);
  await page.screenshot({ path: testInfo.outputPath('discovery-dataset-health-phone.png') });
  await page.getByRole('button', { name: 'Load more board checks' }).click();
  await expect(page.getByText('Company board-51')).toBeVisible();
  await expect(page.getByText('Showing 51 of 51 public boards.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more board checks' })).toHaveCount(0);
});

test('blocked tab storage still allows only one automatic refresh attempt', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key.startsWith('discovery:auto-refresh:'))
        throw new Error('Discovery tab storage is unavailable.');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('discovery:auto-refresh:'))
        throw new Error('Discovery tab storage is unavailable.');
      return setItem.call(this, key, value);
    };
  });

  let postCount = 0;
  await page.route('**/api/v1/discovery', async (route) => {
    await route.fulfill({ json: { data: feed(0) } });
  });
  await page.route('**/api/v1/discovery/refresh', async (route) => {
    postCount += 1;
    await route.fulfill({
      status: 202,
      json: {
        data: {
          started: true,
          task: { id: 'task-storage-blocked', status: 'succeeded' },
        },
      },
    });
  });

  await openDiscover(page);
  await expect(
    page.getByRole('heading', { name: 'Collection finished' }),
  ).toBeVisible();
  await page.waitForTimeout(50);
  expect(postCount).toBe(1);
});

test('Check again only reads the feed while automatic collection is running', async ({
  page,
}) => {
  let getCount = 0;
  let postCount = 0;
  let taskCount = 0;
  await page.route('**/api/v1/discovery', async (route) => {
    getCount += 1;
    await route.fulfill({ json: { data: feed(0) } });
  });
  await page.route('**/api/v1/discovery/refresh', async (route) => {
    postCount += 1;
    await route.fulfill({
      status: 202,
      json: {
        data: {
          started: true,
          task: { id: 'task-running', status: 'running' },
        },
      },
    });
  });
  await page.route('**/api/v1/tasks/task-running', async (route) => {
    taskCount += 1;
    await route.fulfill({
      json: {
        data: {
          id: 'task-running',
          status: taskCount > 1 ? 'succeeded' : 'running',
        },
      },
    });
  });

  await openDiscover(page);
  await expect(
    page.getByRole('heading', {
      name: 'Collecting open roles, this takes about a minute',
    }),
  ).toBeVisible();
  const getsBeforeCheck = getCount;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => getCount).toBeGreaterThan(getsBeforeCheck);
  expect(postCount).toBe(1);
});

test('fallback and per-board health fit desktop and phone layouts', async ({
  page,
}, testInfo) => {
  const coverageFeed = (): Feed => ({
    profileReady: true,
    targetRoles: ['DevOps engineer'],
    matches: [],
    totalActiveJobs: 5,
    updatedAt: '2026-10-15T10:00:00.000Z',
    sources: [
      {
        id: 'greenhouse:northstar',
        provider: 'greenhouse',
        company: 'Northstar Labs',
        board: 'northstar',
        status: 'succeeded',
        lastAttemptAt: '2026-10-15T10:00:00.000Z',
        lastSuccessAt: '2026-10-15T10:00:00.000Z',
        error: null,
        activeJobCount: 3,
      },
      {
        id: 'lever:juniper',
        provider: 'lever',
        company: 'Juniper Works',
        board: 'juniper',
        status: 'succeeded',
        lastAttemptAt: '2026-10-15T10:00:00.000Z',
        lastSuccessAt: '2026-10-15T10:00:00.000Z',
        error: null,
        activeJobCount: 2,
      },
    ],
  });
  await page.route('**/api/v1/discovery', async (route) => {
    await route.fulfill({ json: { data: coverageFeed() } });
  });
  await page.route('**/api/v1/discovery/refresh', async (route) => {
    await route.fulfill({
      status: 202,
      json: {
        data: {
          started: true,
          task: { id: 'task-coverage-screenshot', status: 'succeeded' },
        },
      },
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openDiscover(page);
  await expect(
    page.getByRole('heading', { name: 'Collection finished' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Update your target roles' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Paste a job instead' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Job board checks' })).toBeVisible();
  await expect(page.getByText('Northstar Labs')).toBeVisible();
  await expect(page.getByText('3 active listings')).toBeVisible();
  await expect(page.getByText('Juniper Works')).toBeVisible();
  await expect(page.getByText('2 active listings')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('discovery-coverage-desktop.png'),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, 390);
  await expect(
    page.getByRole('link', { name: 'Update your target roles' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Paste a job instead' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('discovery-coverage-phone-fallback.png'),
  });

  const sourcePanel = page.getByRole('complementary', {
    name: 'Job board checks',
  });
  await sourcePanel.scrollIntoViewIfNeeded();
  await expect(sourcePanel.getByText('Northstar Labs')).toBeVisible();
  await expect(sourcePanel.getByText('3 active listings')).toBeVisible();
  await expect(sourcePanel.getByText('Juniper Works')).toBeVisible();
  await expect(sourcePanel.getByText('2 active listings')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('discovery-coverage-phone-source-health.png'),
  });
});
