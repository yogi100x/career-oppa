import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import {
  browserTestLocalStorageDir,
  deferredLiveProviderEnv,
} from './apps/web/e2e/load-env';

const port = Number(process.env.PLAYWRIGHT_PORT ?? '3001');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error(
    'PLAYWRIGHT_PORT must be a port number between 1024 and 65535.',
  );
const baseURL = `http://localhost:${port}`;
const useProductionServer = process.env.PLAYWRIGHT_PRODUCTION_SERVER === 'true';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalTeardown: './apps/web/e2e/global-teardown.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'clerk-setup',
      testMatch: '**/clerk.setup.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'auth-setup',
      testMatch: '**/auth.setup.ts',
      dependencies: ['clerk-setup'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testMatch: '**/*.spec.ts',
      testIgnore: ['**/*.visual.spec.ts'],
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: resolve('apps/web/e2e/.auth/user-a.json'),
      },
    },
    {
      name: 'workspace-visual',
      testMatch: '**/*.visual.spec.ts',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: resolve('apps/web/e2e/.auth/user-a.json'),
      },
    },
  ],
  webServer: {
    command: useProductionServer ? 'pnpm start' : 'pnpm dev',
    url: baseURL,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      APP_URL: baseURL,
      DATABASE_URL: process.env.DATABASE_TEST_URL,
      NEXT_DIST_DIR: useProductionServer ? '.next-build' : '.next-e2e',
      FEATURE_PRACTICE: process.env.PLAYWRIGHT_PRACTICE_ENABLED ?? 'true',
      FEATURE_PUBLISHING: 'true',
      FEATURE_DISCOVERY: 'true',
      STORAGE_DRIVER: 'local',
      ALLOW_LOCAL_STORAGE_FOR_TESTS: 'true',
      STORAGE_LOCAL_DIR: browserTestLocalStorageDir,
      ...deferredLiveProviderEnv,
    },
    timeout: 120_000,
  },
});
