import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { PrivateStorage } from './types';

const STORAGE_KEY_PATTERN =
  /^files\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.blob$/i;

export class LocalFolderStorage implements PrivateStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    if (!STORAGE_KEY_PATTERN.test(key)) {
      throw new Error('Invalid storage key.');
    }
    const path = resolve(this.root, key);
    const pathFromRoot = relative(this.root, path);
    if (isAbsolute(pathFromRoot) || pathFromRoot.startsWith('..')) {
      throw new Error('Invalid storage key.');
    }
    return path;
  }

  async put(
    key: string,
    contents: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = this.pathFor(key);
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
  }
}
