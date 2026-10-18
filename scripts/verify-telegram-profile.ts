import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import type {
  Browser,
  BrowserContext,
} from '../apps/web/node_modules/@playwright/test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.loadEnvFile(resolve(root, 'apps/web/.env.local'));
process.env.CLERK_PUBLISHABLE_KEY ??=
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';
const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
const { chromium, expect } = webRequire('@playwright/test');
const { clerkSetup, setupClerkTestingToken } = webRequire(
  '@clerk/testing/playwright',
);
const { clerkClient } = webRequire('@clerk/nextjs/server');
const { and, eq } = webRequire('drizzle-orm');
const {
  createDatabase,
  telegramLinkCodes,
  telegramLinks,
  rateLimits,
  users,
  jobs,
  events,
} = webRequire('@career-workspace/db');
const { consumeTelegramLinkCode } = webRequire(
  '@career-workspace/core/telegram-links',
);

const { createJob } = webRequire('@career-workspace/core/roles');

const stage = { name: 'configuration' };
const appUrl = process.env.APP_URL;
const requestedClerkUserId = process.env.CLERK_TEST_USER_ID;

function failAt(name: string): never {
  stage.name = name;
  throw new Error('verification_failed');
}

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) failAt('database-configuration');
  try {
    const parsed = new URL(value);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.pathname !== '/career_workspace_test'
    )
      failAt('database-configuration');
  } catch {
    failAt('database-configuration');
  }
  return value;
}

async function main() {
  // Load private Clerk settings without printing or overwriting caller values.
  process.loadEnvFile(resolve(root, 'apps/web/.env.local'));
  process.env.CLERK_PUBLISHABLE_KEY ??=
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

  if (!appUrl) failAt('configuration');
  let parsedAppUrl: URL;
  try {
    parsedAppUrl = new URL(appUrl);
  } catch {
    failAt('app-url');
  }
  if (
    parsedAppUrl.origin !== 'http://localhost:3194' ||
    parsedAppUrl.pathname !== '/' ||
    parsedAppUrl.search ||
    parsedAppUrl.hash
  )
    failAt('app-url');
  if (requestedClerkUserId && !/^user_[A-Za-z0-9]+$/.test(requestedClerkUserId))
    failAt('identity');
  if (
    !/^pk_test_/.test(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '') ||
    !/^sk_test_/.test(process.env.CLERK_SECRET_KEY ?? '')
  )
    failAt('clerk-configuration');

  const databaseUrl = requiredDatabaseUrl();
  const clerk = await clerkClient();
  const { database, pool } = createDatabase(databaseUrl);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let sessionId: string | undefined;
  let localUserId: string | undefined;
  let createdLocalUser = false;
  let createdJobId: string | undefined;
  let createdRoleId: string | undefined;
  let linkCode: string | undefined;
  let oldRateLimit: { windowStart: Date; count: number } | undefined;
  let rateLimitTouched = false;
  const syntheticTelegramId = `${Date.now()}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`;
  const syntheticChatId = syntheticTelegramId;
  let clerkUserId: string | undefined;

  try {
    stage.name = 'identity';
    const candidates = requestedClerkUserId
      ? [requestedClerkUserId]
      : (await database.select({ clerkId: users.clerkId }).from(users))
          .map((row: { clerkId: string }) => row.clerkId)
          .filter((id: string) => /^user_[A-Za-z0-9]+$/.test(id));
    let identity: { id: string; username?: string | null } | undefined;
    for (const id of candidates) {
      try {
        const candidate = await clerk.users.getUser(id);
        if (
          /^cw_(?:e2e|chat|live|test|cut|auth)_[a-z0-9_]+$/i.test(
            candidate.username ?? '',
          )
        ) {
          identity = candidate;
          clerkUserId = candidate.id;
          break;
        }
      } catch {
        // Ignore stale local Clerk IDs; only existing test identities are eligible.
      }
    }
    if (!identity && !requestedClerkUserId) {
      const existing = await clerk.users.getUserList({ limit: 100 });
      identity = existing.data.find((candidate: { username?: string | null }) =>
        /^cw_(?:e2e|chat|live|test|cut|auth)_[a-z0-9_]+$/i.test(
          candidate.username ?? '',
        ),
      );
      clerkUserId = identity?.id;
    }
    if (!identity || !clerkUserId) failAt('identity');
    let [localUser] = await database
      .select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.clerkId, clerkUserId))
      .limit(1);
    if (!localUser) {
      [localUser] = await database
        .insert(users)
        .values({ clerkId: clerkUserId })
        .returning();
      createdLocalUser = true;
    }
    if (localUser.deletionRequestedAt) failAt('existing-local-user-required');
    localUserId = localUser.id;

    // Refuse to disturb a pre-existing connection or pending code.
    const [existingLink] = await database
      .select({ userId: telegramLinks.userId })
      .from(telegramLinks)
      .where(eq(telegramLinks.userId, localUserId))
      .limit(1);
    const [existingCode] = await database
      .select({ userId: telegramLinkCodes.userId })
      .from(telegramLinkCodes)
      .where(eq(telegramLinkCodes.userId, localUserId))
      .limit(1);
    if (existingLink || existingCode) failAt('telegram-fixture-not-clean');
    const role = await createJob(
      localUserId,
      {
        title: 'Telegram browser check',
        company: 'Test company',
        text: `Browser verification role ${randomUUID()}. Work with TypeScript and PostgreSQL to build reliable web services, review code, and maintain automated checks. This is a private test fixture.`,
      },
      { database },
    );
    createdJobId = role.job.id;
    createdRoleId = role.opportunity.id;
    const returnPath = `/workspace/roles/${createdRoleId}`;

    stage.name = 'ticket';
    const ticket = await clerk.signInTokens.createSignInToken({
      userId: clerkUserId,
      expiresInSeconds: 120,
    });
    stage.name = 'browser-launch';
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ baseURL: parsedAppUrl.origin });
    const page = await context.newPage();
    // Allow the local development server to compile the first role request.
    page.setDefaultNavigationTimeout(120_000);
    stage.name = 'browser-testing-token';
    await clerkSetup();
    await setupClerkTestingToken({ page });

    stage.name = 'sign-in';
    await page.goto(new URL(returnPath, parsedAppUrl).toString());
    if (new URL(page.url()).searchParams.get('redirect_url') !== returnPath)
      failAt('signed-out-role-return');
    await page.waitForFunction(() =>
      Boolean((window as Window & { Clerk?: unknown }).Clerk),
    );
    sessionId = await page.evaluate(async (token) => {
      const clerk = (
        window as Window & {
          Clerk?: {
            load: () => Promise<void>;
            client: {
              signIn: {
                create: (input: {
                  strategy: 'ticket';
                  ticket: string;
                }) => Promise<{
                  createdSessionId?: string | null;
                }>;
              };
            };
            setActive: (input: { session: string }) => Promise<void>;
          };
        }
      ).Clerk;
      if (!clerk) throw new Error('clerk_unavailable');
      await clerk.load();
      const result = await clerk.client.signIn.create({
        strategy: 'ticket',
        ticket: token,
      });
      if (!result.createdSessionId) throw new Error('ticket_sign_in_failed');
      await clerk.setActive({ session: result.createdSessionId });
      return result.createdSessionId;
    }, ticket.token);

    stage.name = 'signed-in-role-return';
    await page.goto(
      new URL(
        `/auth/complete?next=${encodeURIComponent(returnPath)}`,
        parsedAppUrl,
      ).toString(),
    );
    stage.name = 'signed-in-role-url';
    await expect(page).toHaveURL(new URL(returnPath, parsedAppUrl).toString());
    stage.name = 'signed-in-role-heading';
    await expect(
      page.getByRole('heading', {
        name: 'Telegram browser check',
        exact: true,
      }),
    ).toBeVisible();

    stage.name = 'profile';
    let rejectStatus = true;
    await page.route('**/api/v1/telegram/link', async (route) => {
      if (rejectStatus && route.request().method() === 'GET') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Temporary test error' } }),
        });
      } else await route.continue();
    });
    await page.goto(new URL('/workspace/profile', parsedAppUrl).toString());
    await expect(
      page.getByRole('heading', { name: 'Telegram reminders' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry connection check' }),
    ).toBeVisible();
    rejectStatus = false;
    await page.getByRole('button', { name: 'Retry connection check' }).click();
    await expect(
      page.getByRole('button', { name: 'Connect Telegram' }),
    ).toBeVisible();
    await expect(page.getByText('Temporary test error')).toHaveCount(0);
    await page.unroute('**/api/v1/telegram/link');

    await expect(
      page.getByText(/Reminders are on by default after you connect/),
    ).toBeVisible();
    await expect(page.getByText(/Send\s+\/stop\s+to the bot/)).toBeVisible();
    const initialResponse = await page.request.get('/api/v1/telegram/link');
    if (!initialResponse.ok()) failAt('initial-status');
    const initialBody = (await initialResponse.json()) as {
      data?: { linked?: boolean; linkedAt?: string | null };
    };
    const initialStatus = initialBody.data;
    if (
      !initialStatus ||
      initialStatus.linked !== false ||
      Object.keys(initialStatus).some(
        (key) => !['linked', 'linkedAt'].includes(key),
      )
    )
      failAt('initial-status');
    await expect(
      page.getByRole('button', { name: 'Connect Telegram' }),
    ).toBeVisible();

    stage.name = 'create-link';
    const [rateLimitBefore] = await database
      .select()
      .from(rateLimits)
      .where(
        and(
          eq(rateLimits.userId, localUserId),
          eq(rateLimits.actionKey, 'telegram_link_code'),
        ),
      )
      .limit(1);
    oldRateLimit = rateLimitBefore;
    rateLimitTouched = true;
    const createResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/v1/telegram/link' &&
        response.request().method() === 'POST'
      );
    });
    await page.getByRole('button', { name: 'Connect Telegram' }).click();
    const createResponse = await createResponsePromise;
    if (!createResponse.ok()) failAt('create-link');
    const createdBody = (await createResponse.json()) as {
      data?: { url?: string; expiresAt?: string };
    };
    const linkUrl = createdBody.data?.url;
    const expiresAt = createdBody.data?.expiresAt;
    if (!linkUrl || !expiresAt) failAt('create-link');
    let telegramUrl: URL;
    try {
      telegramUrl = new URL(linkUrl);
    } catch {
      failAt('create-link');
    }
    if (
      telegramUrl.protocol !== 'https:' ||
      telegramUrl.hostname !== 't.me' ||
      telegramUrl.pathname !== '/CareerOppaBot'
    )
      failAt('create-link');
    linkCode = telegramUrl.searchParams.get('start') ?? undefined;
    if (!linkCode || !/^[A-Za-z0-9_-]{40,}$/.test(linkCode))
      failAt('create-link');
    const remainingMs = new Date(expiresAt).getTime() - Date.now();
    if (
      !Number.isFinite(remainingMs) ||
      remainingMs < 9 * 60_000 ||
      remainingMs > 10 * 60_000
    )
      failAt('expiry');
    await expect(
      page.getByRole('link', { name: 'Open Career Oppa in Telegram' }),
    ).toHaveAttribute('href', linkUrl);
    await expect(
      page.getByText(/one-time link expires in 10 minutes/i),
    ).toBeVisible();

    stage.name = 'simulate-telegram-start';
    const consumed = await consumeTelegramLinkCode(
      linkCode,
      syntheticTelegramId,
      syntheticChatId,
      {
        database,
      },
    );
    if (consumed.status !== 'linked') failAt('simulate-telegram-start');
    await page
      .getByRole('button', { name: 'I pressed Start — check connection' })
      .click();
    await expect(page.getByText(/^Connected on /)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Disconnect Telegram' }),
    ).toBeVisible();

    stage.name = 'disconnect';
    await page.getByRole('button', { name: 'Disconnect Telegram' }).click();
    await expect(
      page.getByText(
        'Disconnect Telegram? You will stop receiving reminders there.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Yes, disconnect' }).click();
    await expect(page.getByText('Not connected.')).toBeVisible();
    const finalResponse = await page.request.get('/api/v1/telegram/link');
    if (!finalResponse.ok()) failAt('disconnect');
    const finalBody = (await finalResponse.json()) as {
      data?: { linked?: boolean };
    };
    if (finalBody.data?.linked !== false) failAt('disconnect');

    for (const passed of [
      'signed-out-role-return',
      'signed-in-role-return',
      'profile',
      'create-link',
      'expiry',
      'simulate-telegram-start',
      'disconnect',
    ])
      console.log(`PASS ${passed}`);
  } finally {
    // No link or code existed before this run, and the identity is dedicated.
    if (localUserId) {
      const conditions = [
        eq(telegramLinks.userId, localUserId),
        eq(telegramLinks.telegramUserId, syntheticTelegramId),
      ];
      await database.delete(telegramLinks).where(and(...conditions));
      if (linkCode)
        await database
          .delete(telegramLinkCodes)
          .where(
            and(
              eq(telegramLinkCodes.userId, localUserId),
              eq(
                telegramLinkCodes.codeHash,
                createHash('sha256').update(linkCode).digest('hex'),
              ),
            ),
          );
      if (rateLimitTouched) {
        if (oldRateLimit) {
          await database
            .update(rateLimits)
            .set({
              windowStart: oldRateLimit.windowStart,
              count: oldRateLimit.count,
            })
            .where(
              and(
                eq(rateLimits.userId, localUserId),
                eq(rateLimits.actionKey, 'telegram_link_code'),
              ),
            );
        } else {
          await database
            .delete(rateLimits)
            .where(
              and(
                eq(rateLimits.userId, localUserId),
                eq(rateLimits.actionKey, 'telegram_link_code'),
              ),
            );
        }
      }
    }
    await context?.close();
    await browser?.close();
    if (sessionId) {
      try {
        await clerk.sessions.revokeSession(sessionId);
      } catch {
        console.error('CLEANUP session-revocation-failed');
      }
    }
    if (createdRoleId && localUserId)
      await database
        .delete(events)
        .where(
          and(
            eq(events.userId, localUserId),
            eq(events.subjectId, createdRoleId),
          ),
        );
    if (createdJobId && localUserId)
      await database
        .delete(jobs)
        .where(and(eq(jobs.userId, localUserId), eq(jobs.id, createdJobId)));
    if (createdLocalUser && localUserId)
      await database.delete(users).where(eq(users.id, localUserId));
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const kind = error instanceof Error ? error.name : 'UnknownError';
  console.error(`FAIL ${stage.name} (${kind})`);
  if (error instanceof Error && /Executable doesn't exist/.test(error.message))
    console.error(
      'Browser executable is not installed for this Playwright version.',
    );
  process.exitCode = 1;
});
