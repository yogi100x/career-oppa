import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const browserTestLocalStorageDir = resolve(
  process.cwd(),
  'apps/web/.local-storage',
);

export const deferredLiveProviderEnv = {
  OPENROUTER_API_KEY: '',
  OPENROUTER_MODEL: '',
  GETLEADS_API_KEY: '',
  ZERNIO_API_KEY: '',
  ZERNIO_WEBHOOK_SECRET: '',
  DODO_PAYMENTS_API_KEY: '',
  DODO_PAYMENTS_WEBHOOK_SECRET: '',
  DODO_PAYMENTS_ENVIRONMENT: '',
  DODO_PAYMENTS_RETURN_URL: '',
  DODO_PRODUCT_STARTER: '',
  DODO_PRODUCT_JOBHUNT: '',
  DODO_PRODUCT_FULLSEASON: '',
};

const webEnvFile = resolve(process.cwd(), 'apps/web/.env.local');
if (existsSync(webEnvFile)) {
  process.loadEnvFile(webEnvFile);
}

process.env.CLERK_PUBLISHABLE_KEY ??=
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

const configuredDatabaseUrl =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
if (!configuredDatabaseUrl) {
  throw new Error('A local PostgreSQL URL is required for browser tests.');
}

const testDatabaseUrl = new URL(configuredDatabaseUrl);
if (testDatabaseUrl.pathname.slice(1) !== 'career_workspace_test') {
  if (
    process.env.DATABASE_TEST_URL ||
    !['localhost', '127.0.0.1', '::1'].includes(testDatabaseUrl.hostname)
  ) {
    throw new Error(
      'Browser tests must use a database named career_workspace_test.',
    );
  }
  testDatabaseUrl.pathname = '/career_workspace_test';
}

process.env.DATABASE_TEST_URL = testDatabaseUrl.toString();
process.env.DATABASE_URL = testDatabaseUrl.toString();
Object.assign(process.env, deferredLiveProviderEnv, {
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: browserTestLocalStorageDir,
});
