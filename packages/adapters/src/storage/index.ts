import { LocalFolderStorage } from './local';
import { R2Storage } from './r2';
import { StorageConfigurationError, type PrivateStorage } from './types';

export type StorageEnvironment = Record<string, string | undefined>;

function isLocalTestDatabase(environment: StorageEnvironment): boolean {
  if (
    environment.ALLOW_LOCAL_STORAGE_FOR_TESTS !== 'true' ||
    environment.VERCEL
  )
    return false;
  try {
    const url = new URL(environment.DATABASE_URL ?? '');
    const name = url.pathname.replace(/^\//, '');
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      name === 'career_workspace_test' &&
      ['', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.searchParams.has('host') &&
      !url.searchParams.has('hostaddr')
    );
  } catch {
    return false;
  }
}

export function createStorage(
  environment: StorageEnvironment = process.env,
): PrivateStorage {
  const production =
    environment.NODE_ENV === 'production' || Boolean(environment.VERCEL);
  const testStorageAllowed = isLocalTestDatabase(environment);
  const driver =
    environment.STORAGE_DRIVER ??
    (production && !testStorageAllowed ? '' : 'local');
  if (driver === 'local') {
    if (production && !testStorageAllowed)
      throw new StorageConfigurationError(
        'Local storage is disabled in production. Configure R2 storage.',
      );
    const root =
      environment.STORAGE_LOCAL_DIR ?? `${process.cwd()}/.local-storage`;
    return new LocalFolderStorage(root);
  }
  if (driver !== 'r2') {
    throw new StorageConfigurationError('STORAGE_DRIVER must be local or r2.');
  }

  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  } = environment;
  if (
    !R2_ACCOUNT_ID ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_BUCKET_NAME
  ) {
    throw new StorageConfigurationError(
      'R2 storage is missing required server configuration.',
    );
  }
  return new R2Storage({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucketName: R2_BUCKET_NAME,
    keyPrefix: environment.R2_KEY_PREFIX,
  });
}

let privateStorage: PrivateStorage | undefined;

/** Lazily creates the one storage driver used by server-side file operations. */
export function getPrivateStorage(): PrivateStorage {
  privateStorage ??= createStorage(process.env);
  return privateStorage;
}

export { LocalFolderStorage } from './local';
export { R2Storage } from './r2';
export { StorageConfigurationError } from './types';
export type { PrivateStorage } from './types';
