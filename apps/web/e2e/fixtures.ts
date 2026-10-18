import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

type ClerkWindow = Window & {
  Clerk?: {
    loaded?: boolean;
    session?: { getToken(): Promise<string | null> } | null;
  };
};

async function refreshBrowserSession(page: Page, baseURL?: string) {
  if (!baseURL)
    throw new Error('Playwright baseURL is required for auth refresh.');
  const workspaceUrl = new URL('/workspace', baseURL).toString();
  if (page.url() !== workspaceUrl) await page.goto(workspaceUrl);
  await page.waitForFunction(() =>
    Boolean((window as ClerkWindow).Clerk?.loaded),
  );
  const token = await page.evaluate(() =>
    (window as ClerkWindow).Clerk?.session?.getToken(),
  );
  if (!token)
    throw new Error('The signed-in Clerk session could not be refreshed.');
  // Clerk's SDK returns a fresh session JWT. APIRequestContext does not run the
  // browser SDK's refresh flow, so update this browser context's session cookie.
  await page
    .context()
    .addCookies([{ name: '__session', value: token, url: baseURL }]);
}

export async function createRefreshedBrowserContext(
  browser: Browser,
  storageState: string,
  baseURL: string,
): Promise<{
  context: BrowserContext;
  page: Page;
  stopSessionRefresh(): Promise<void>;
  close(): Promise<void>;
}> {
  const context = await browser.newContext({ storageState, baseURL });
  const page = await context.newPage();
  const refreshPage = await context.newPage();
  try {
    await refreshBrowserSession(refreshPage, baseURL);
  } catch (error) {
    await context.close();
    throw error;
  }
  const stopRefreshTimer = startPeriodicSessionRefresh(refreshPage, baseURL);
  let stopPromise: Promise<void> | undefined;
  const stopSessionRefresh = () => {
    stopPromise ??= (async () => {
      let refreshFailure: unknown;
      try {
        await stopRefreshTimer();
      } catch (error) {
        refreshFailure = error;
      }
      try {
        await refreshPage.close();
      } catch (error) {
        refreshFailure ??= error;
      }
      if (refreshFailure) throw refreshFailure;
    })();
    return stopPromise;
  };
  return {
    context,
    page,
    stopSessionRefresh,
    async close() {
      try {
        await stopSessionRefresh();
      } finally {
        await context.close();
      }
    },
  };
}

function startPeriodicSessionRefresh(page: Page, baseURL?: string) {
  let closed = false;
  let refreshError: Error | undefined;
  let pendingRefresh: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (closed || pendingRefresh) return;
    pendingRefresh = refreshBrowserSession(page, baseURL)
      .catch((error) => {
        refreshError =
          error instanceof Error
            ? error
            : new Error('Clerk session refresh failed.');
      })
      .finally(() => {
        pendingRefresh = undefined;
      });
  }, 20_000);
  return async () => {
    closed = true;
    clearInterval(timer);
    await pendingRefresh;
    if (refreshError) throw refreshError;
  };
}

export const test = base.extend({
  page: async ({ page, baseURL }, use, testInfo) => {
    let authPage: Page | undefined;
    let stopRefresh: (() => void) | undefined;
    try {
      if (testInfo.project.name === 'chromium') {
        authPage = await page.context().newPage();
        await refreshBrowserSession(authPage, baseURL);
        stopRefresh = startPeriodicSessionRefresh(authPage, baseURL);
      }
      await use(page);
    } finally {
      try {
        await stopRefresh?.();
      } finally {
        await authPage?.close();
      }
    }
  },
});

export { expect };
export type { APIRequestContext } from '@playwright/test';
