import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clerkClient } from '@clerk/nextjs/server';
import { setupClerkTestingToken } from '@clerk/testing/playwright';
import { expect, test as setup, type Browser } from '@playwright/test';
import globalTeardown from './global-teardown';
import { clerkTestUserParams } from './clerk-test-user';

const authDirectory = resolve('apps/web/e2e/.auth');
const fixturesPath = resolve(authDirectory, 'users.json');

type UserFixture = {
  clerkId: string;
  username: string;
  owned: boolean;
  sessionId?: string;
};
type UserFixtures = {
  userA?: UserFixture;
  userB?: UserFixture;
  userC?: UserFixture;
  userD?: UserFixture;
};

async function signInWithTicket(
  browser: Browser,
  baseURL: string,
  userId: string,
  storagePath: string,
  onSession: (sessionId: string) => Promise<void>,
): Promise<void> {
  const client = await clerkClient();
  const ticket = await client.signInTokens.createSignInToken({
    userId,
    expiresInSeconds: 120,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await setupClerkTestingToken({ page });
    await page.goto(`${baseURL}/sign-in`);
    await page.waitForFunction(() =>
      Boolean((window as unknown as Window & { Clerk?: unknown }).Clerk),
    );
    const sessionId = await page.evaluate(async (token) => {
      const clerk = (
        window as unknown as Window & {
          Clerk?: {
            load: () => Promise<void>;
            client: {
              signIn: {
                create: (params: {
                  strategy: 'ticket';
                  ticket: string;
                }) => Promise<{
                  createdSessionId?: string | null;
                }>;
              };
            };
            setActive: (params: { session: string }) => Promise<void>;
          };
        }
      ).Clerk;
      if (!clerk) throw new Error('Clerk did not load on the sign-in page.');
      await clerk.load();

      const attempt = await clerk.client.signIn.create({
        strategy: 'ticket',
        ticket: token,
      });
      if (!attempt.createdSessionId) {
        throw new Error(
          'Clerk did not create a session from the sign-in ticket.',
        );
      }
      await clerk.setActive({ session: attempt.createdSessionId });
      return attempt.createdSessionId;
    }, ticket.token);
    await onSession(sessionId);

    await page.goto(`${baseURL}/workspace`);
    await expect(page).toHaveURL(/\/workspace(?:$|\?)/);
    await expect(
      page.getByRole('heading', {
        name: /Your next step starts here\.|Find a role that fits you\./,
      }),
    ).toBeVisible({ timeout: 30_000 });
    expect((await page.request.get('/api/v1/me')).status()).toBe(200);
    expect((await page.request.get('/api/v1/credits')).status()).toBe(200);

    await context.storageState({ path: storagePath });
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await context.close();
  }
}

setup.describe.configure({ mode: 'serial' });

setup(
  'create temporary Clerk users and browser sessions A through D',
  async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error('Playwright baseURL is required.');
    // Four real Clerk sessions plus cold Next route compilation can exceed
    // Playwright's default 30 seconds on the shared Linux runner.
    setup.setTimeout(90_000);
    await globalTeardown();
    await mkdir(authDirectory, { recursive: true });
    const fixtures: UserFixtures = {};
    await writeFile(fixturesPath, JSON.stringify(fixtures), { mode: 0o600 });

    const client = await clerkClient();
    const configuredIds = process.env.CLERK_E2E_USER_IDS;
    if (configuredIds) {
      const ids = configuredIds.split(',').map((id) => id.trim());
      if (
        ids.length !== 4 ||
        ids.some((id) => !id) ||
        new Set(ids).size !== 4
      ) {
        throw new Error(
          'CLERK_E2E_USER_IDS must contain four distinct Clerk test user IDs.',
        );
      }
      const identities = await Promise.all(
        ids.map((id) => client.users.getUser(id)),
      );
      const testUsername = /^cw_(?:e2e|chat|live|test|cut|auth)_[a-z0-9_]+$/i;
      if (
        identities.some(
          (identity) => !testUsername.test(identity.username ?? ''),
        )
      ) {
        throw new Error(
          'CLERK_E2E_USER_IDS may only reference dedicated cw_* test identities.',
        );
      }
      const keys = ['userA', 'userB', 'userC', 'userD'] as const;
      identities.forEach((identity, index) => {
        fixtures[keys[index]] = {
          clerkId: identity.id,
          username: identity.username!,
          owned: false,
        };
      });
    } else {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
      for (const [index, key] of (
        ['userA', 'userB', 'userC', 'userD'] as const
      ).entries()) {
        const username = `cw_e2e_${String.fromCharCode(97 + index)}_${suffix}`;
        const identity = await client.users.createUser(
          clerkTestUserParams(username),
        );
        fixtures[key] = { clerkId: identity.id, username, owned: true };
        await writeFile(fixturesPath, JSON.stringify(fixtures), {
          mode: 0o600,
        });
        const email = identity.emailAddresses.find(
          (address) =>
            address.emailAddress === `${username}+clerk_test@example.com`,
        );
        expect(email?.verification?.status).toBe('verified');
      }
    }
    await writeFile(fixturesPath, JSON.stringify(fixtures), { mode: 0o600 });

    const keys = ['userA', 'userB', 'userC', 'userD'] as const;
    for (const [index, key] of keys.entries()) {
      const fixture = fixtures[key]!;
      await signInWithTicket(
        browser,
        baseURL,
        fixture.clerkId,
        resolve(authDirectory, `user-${String.fromCharCode(97 + index)}.json`),
        async (sessionId) => {
          fixture.sessionId = sessionId;
          await writeFile(fixturesPath, JSON.stringify(fixtures), {
            mode: 0o600,
          });
        },
      );
    }
  },
);
