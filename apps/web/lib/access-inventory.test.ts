import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  USER_ACCESS_GUARD_EXEMPTIONS,
  USER_ACCESS_GUARD_ROUTES,
} from '../e2e/ownership.routes';

const methods = [
  'GET',
  'POST',
  'PATCH',
  'DELETE',
  'PUT',
  'HEAD',
  'OPTIONS',
] as const;

async function findRouteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findRouteFiles(path);
      return entry.name === 'route.ts' ? [path] : [];
    }),
  );
  return nested.flat();
}

function inventoryPath(path: string): string {
  return path.replace(/\[([^\]]+)\]/g, '{$1}').split('?')[0];
}

describe('API access guard inventory', () => {
  it('accounts for every exported API method as guarded or explicitly exempt', async () => {
    const apiRoot = resolve('apps/web/app/api');
    const routeFiles = await findRouteFiles(apiRoot);
    const actual: string[] = [];
    const exportPattern =
      /export\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/g;

    for (const file of routeFiles) {
      const source = await readFile(file, 'utf8');
      const path = inventoryPath(
        `/api/${relative(apiRoot, file)
          .replace(/[/\\]route\.ts$/, '')
          .replaceAll('\\', '/')}`,
      );
      for (const match of source.matchAll(exportPattern)) {
        const method = match[1] ?? match[2];
        if (methods.includes(method as (typeof methods)[number]))
          actual.push(`${method} ${path}`);
      }
    }

    const normalizeEntry = (method: string, path: string) =>
      `${method} ${inventoryPath(path.replaceAll('00000000-0000-4000-8000-000000000001', '{id}'))}`;
    const accounted = new Set([
      ...USER_ACCESS_GUARD_ROUTES.map(({ method, path }) =>
        normalizeEntry(method, path),
      ),
      ...USER_ACCESS_GUARD_EXEMPTIONS.map(({ method, path }) =>
        normalizeEntry(method, path),
      ),
    ]);
    const actualSet = new Set(actual);

    expect([...actualSet].filter((route) => !accounted.has(route))).toEqual([]);
    expect([...accounted].filter((route) => !actualSet.has(route))).toEqual([]);
    expect(
      USER_ACCESS_GUARD_EXEMPTIONS.every(
        ({ reason }) => reason.trim().length > 0,
      ),
    ).toBe(true);
  });
});
