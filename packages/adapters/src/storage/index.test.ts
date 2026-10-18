import { describe, expect, it } from 'vitest';
import { createStorage } from './index';
import { StorageConfigurationError } from './types';

describe('storage driver selection', () => {
  it('uses local storage by default in development', () => {
    expect(() => createStorage({ NODE_ENV: 'development' })).not.toThrow();
  });

  it.each([
    { NODE_ENV: 'production' },
    { NODE_ENV: 'production', STORAGE_DRIVER: 'local' },
    {
      NODE_ENV: 'production',
      STORAGE_DRIVER: 'local',
      ALLOW_LOCAL_STORAGE_FOR_TESTS: 'true',
      DATABASE_URL: 'postgresql://localhost:5432/other_db',
    },
    {
      NODE_ENV: 'production',
      STORAGE_DRIVER: 'local',
      ALLOW_LOCAL_STORAGE_FOR_TESTS: 'true',
      DATABASE_URL: 'postgresql://db.example.com/career_workspace_test',
    },
    {
      NODE_ENV: 'production',
      STORAGE_DRIVER: 'local',
      ALLOW_LOCAL_STORAGE_FOR_TESTS: 'true',
      DATABASE_URL:
        'postgresql://localhost:5432/career_workspace_test?host=db.example.com',
    },
    {
      NODE_ENV: 'production',
      STORAGE_DRIVER: 'local',
      ALLOW_LOCAL_STORAGE_FOR_TESTS: 'true',
      DATABASE_URL:
        'postgresql://localhost:5432/career_workspace_test?hostaddr=203.0.113.10',
    },
    {
      NODE_ENV: 'production',
      STORAGE_DRIVER: 'local',
      ALLOW_LOCAL_STORAGE_FOR_TESTS: 'true',
      DATABASE_URL: 'postgresql://localhost:5432/career_workspace_test',
      VERCEL: '1',
    },
    { VERCEL: '1' },
    { VERCEL: '1', STORAGE_DRIVER: 'local' },
  ])('fails closed for production local storage: %o', (environment) => {
    expect(() => createStorage(environment)).toThrow(StorageConfigurationError);
  });

  it('permits local storage in the isolated local production-build test server only', () => {
    expect(() =>
      createStorage({
        NODE_ENV: 'production',
        STORAGE_DRIVER: 'local',
        ALLOW_LOCAL_STORAGE_FOR_TESTS: 'true',
        DATABASE_URL: 'postgresql://localhost:5432/career_workspace_test',
      }),
    ).not.toThrow();
  });
});
