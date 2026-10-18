import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFolderStorage } from './local';

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe('local private storage', () => {
  it('stores, reads, and deletes content using a generated key', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'career-files-'));
    const storage = new LocalFolderStorage(temporaryRoot);
    const key = 'files/550e8400-e29b-41d4-a716-446655440000.blob';
    const contents = new TextEncoder().encode('private cv contents');

    await storage.put(key, contents, 'application/pdf');

    expect(await storage.get(key)).toEqual(contents);
    expect(await readFile(join(temporaryRoot, key), 'utf8')).toBe(
      'private cv contents',
    );
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
  });

  it('rejects path traversal keys', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'career-files-'));
    const storage = new LocalFolderStorage(temporaryRoot);

    await expect(storage.get('../outside')).rejects.toThrow(
      'Invalid storage key.',
    );
  });
});
