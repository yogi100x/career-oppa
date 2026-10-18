import './load-env';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clerkClient } from '@clerk/nextjs/server';
import { and, eq, inArray } from 'drizzle-orm';
import {
  closeDatabase,
  events,
  getDatabase,
  suppressions,
  users,
} from '@career-workspace/db';

const authDirectory = resolve('apps/web/e2e/.auth');
const fixturesPath = resolve(authDirectory, 'users.json');

type UserFixtures = {
  userA?: UserFixture;
  userB?: UserFixture;
  userC?: UserFixture;
  userD?: UserFixture;
};
type UserFixture = {
  clerkId: string;
  username?: string;
  owned?: boolean;
  sessionId?: string;
};

function assertTestDatabase(): void {
  const configured = process.env.DATABASE_TEST_URL;
  if (!configured)
    throw new Error('DATABASE_TEST_URL is required for browser cleanup.');
  const databaseUrl = new URL(configured);
  if (databaseUrl.pathname.replace(/^\//, '') !== 'career_workspace_test') {
    throw new Error('Browser cleanup is restricted to career_workspace_test.');
  }
}

export default async function globalTeardown(): Promise<void> {
  let fixtures: UserFixtures = {};
  try {
    fixtures = JSON.parse(await readFile(fixturesPath, 'utf8')) as UserFixtures;
  } catch {
    await rm(authDirectory, { recursive: true, force: true });
    return;
  }

  const entries = Object.entries(fixtures).filter(
    (entry): entry is [keyof UserFixtures, UserFixture] =>
      Boolean(entry[1]?.clerkId),
  );
  const clerkIds = entries.map(([, fixture]) => fixture.clerkId);
  const ownedClerkIds = entries
    .filter(([, fixture]) => fixture.owned !== false)
    .map(([, fixture]) => fixture.clerkId);

  const failures: string[] = [];
  let databaseCleanupFailed = false;
  const failedClerkIds: string[] = [];
  const failedSessionIds = new Set<string>();

  const sessions = entries.flatMap(([, fixture]) =>
    fixture.sessionId
      ? [{ clerkId: fixture.clerkId, sessionId: fixture.sessionId }]
      : [],
  );
  if (sessions.length) {
    try {
      const client = await clerkClient();
      for (const { clerkId, sessionId } of sessions) {
        try {
          await client.sessions.revokeSession(sessionId);
        } catch (error) {
          const status =
            (error as { status?: number; statusCode?: number })?.status ??
            (error as { statusCode?: number })?.statusCode;
          if (
            status !== 404 &&
            (!(error instanceof Error) ||
              !error.message.toLowerCase().includes('not found'))
          ) {
            failedSessionIds.add(sessionId);
            failedClerkIds.push(clerkId);
          }
        }
      }
      if (failedSessionIds.size) failures.push('Clerk sessions');
    } catch {
      for (const { clerkId, sessionId } of sessions) {
        failedSessionIds.add(sessionId);
        failedClerkIds.push(clerkId);
      }
      failures.push('Clerk client');
    }
  }

  if (clerkIds.length) {
    let database: ReturnType<typeof getDatabase> | undefined;
    try {
      assertTestDatabase();
      database = getDatabase();
    } catch {
      databaseCleanupFailed = true;
      failures.push('database connection');
    }

    if (database) {
      try {
        const ownerRows = await database
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.clerkId, clerkIds));
        const ownerIds = ownerRows.map((row) => row.id);
        if (ownerIds.length) {
          const ownedSuppressions = await database
            .select({ id: suppressions.id })
            .from(suppressions)
            .where(inArray(suppressions.createdBy, ownerIds));
          const suppressionIds = ownedSuppressions.map((row) => row.id);
          if (suppressionIds.length) {
            await database
              .delete(events)
              .where(
                and(
                  eq(events.subjectType, 'suppression'),
                  inArray(events.subjectId, suppressionIds),
                ),
              );
            await database
              .delete(suppressions)
              .where(inArray(suppressions.id, suppressionIds));
          }
        }
      } catch {
        databaseCleanupFailed = true;
        failures.push('suppression rows');
      }

      try {
        await database.delete(users).where(inArray(users.clerkId, clerkIds));
      } catch {
        databaseCleanupFailed = true;
        failures.push('local users');
      }
    }

    try {
      const client = await clerkClient();
      for (const clerkId of ownedClerkIds) {
        try {
          await client.users.deleteUser(clerkId);
        } catch (error) {
          const status =
            (error as { status?: number; statusCode?: number })?.status ??
            (error as { statusCode?: number })?.statusCode;
          if (
            status !== 404 &&
            (!(error instanceof Error) || !error.message.includes('not found'))
          ) {
            failedClerkIds.push(clerkId);
          }
        }
      }
      if (failedClerkIds.length) failures.push('Clerk identities');
    } catch {
      failedClerkIds.push(...ownedClerkIds);
      failures.push('Clerk client');
    }
  }

  try {
    await closeDatabase();
  } catch {
    databaseCleanupFailed = true;
    failures.push('database shutdown');
  }

  if (failures.length) {
    const retainedIds = databaseCleanupFailed ? clerkIds : failedClerkIds;
    const retainedFixtures: UserFixtures = {};
    for (const [key, fixture] of Object.entries(fixtures)) {
      if (fixture && retainedIds.includes(fixture.clerkId)) {
        const retained = { ...fixture };
        if (!retained.sessionId || !failedSessionIds.has(retained.sessionId)) {
          delete retained.sessionId;
        }
        retainedFixtures[key as keyof UserFixtures] = retained;
      }
    }
    await mkdir(authDirectory, { recursive: true });
    for (const entry of await readdir(authDirectory)) {
      if (entry !== 'users.json')
        await rm(resolve(authDirectory, entry), {
          recursive: true,
          force: true,
        });
    }
    await writeFile(fixturesPath, JSON.stringify(retainedFixtures), {
      mode: 0o600,
    });
    throw new Error(
      `Browser test cleanup failed (${failures.join(', ')}). Fixture IDs were retained for retry.`,
    );
  }

  await rm(authDirectory, { recursive: true, force: true });
}
