import './load-env';
import { clerkTestUserParams } from './clerk-test-user';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { clerkClient } from '@clerk/nextjs/server';
import { closeDatabase, getDatabase, ledgerEntries, users } from '@career-workspace/db';
import { eq } from 'drizzle-orm';

let stage = 'initializing';
const placeholderPattern = /placeholder|your[_ -]?key|replace[_ -]?me|example|dummy|todo/i;

function hasDevelopmentClerkKeys() {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  return Boolean(
    publishableKey?.startsWith('pk_test_') && publishableKey.length > 24 && !placeholderPattern.test(publishableKey) &&
    secretKey?.startsWith('sk_test_') && secretKey.length > 24 && !placeholderPattern.test(secretKey),
  );
}

async function runProof() {
  if (!hasDevelopmentClerkKeys())
    throw new Error('Real Clerk development keys are required; no fixture was created.');

  const baseUrl = 'http://localhost:3002';
  const extensionDir = resolve('apps/extension/dist');
  const extensionId = 'efpojcicpmejmpjeeaekchonofonmbkm';
  const profile = await mkdtemp(resolve(tmpdir(), 'cw-extension-proof-'));
  const clerk = await clerkClient();
  const username = `cw_extension_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const testUser = clerkTestUserParams(username);
  let clerkId: string | undefined;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let authorizationHeader: string | undefined;
  let requestOrigin: string | undefined;
  let meResponseStatus: number | undefined;
  let captureResponseStatus: number | undefined;

  try {
    stage = 'creating-user';
    const user = await clerk.users.createUser(testUser);
    clerkId = user.id;
    stage = 'creating-ticket';
    const ticket = await clerk.signInTokens.createSignInToken({ userId: user.id, expiresInSeconds: 120 });
    stage = 'launching-browser';
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    stage = 'signing-in';
    const web = await context.newPage();
    await web.goto(`${baseUrl}/sign-in`);
    await web.waitForFunction(() => Boolean((window as unknown as Window & { Clerk?: unknown }).Clerk));
    await web.evaluate(async (token) => {
      const clerk = (window as unknown as Window & {
        Clerk?: {
          load: () => Promise<void>;
          client: { signIn: { create: (params: { strategy: 'ticket'; ticket: string }) => Promise<{ createdSessionId?: string | null }> } };
          setActive: (params: { session: string }) => Promise<void>;
        };
      }).Clerk;
      if (!clerk) throw new Error('Clerk unavailable on sign-in page');
      await clerk.load();
      const result = await clerk.client.signIn.create({ strategy: 'ticket', ticket: token });
      if (!result.createdSessionId) throw new Error('Ticket did not create a session');
      await clerk.setActive({ session: result.createdSessionId });
    }, ticket.token);

    await web.goto(`${baseUrl}/workspace`);
    await expect(web).toHaveURL(/\/workspace$/);

    stage = 'opening-popup';
    const popup = await context.newPage();
    popup.on('pageerror', (error) => console.log(`EXTENSION_PAGE_ERROR=${error.name}`));
    popup.on('console', (message) => {
      if (message.type() === 'error') console.log('EXTENSION_CONSOLE_ERROR=true');
    });
    popup.on('request', (request) => {
      if (new URL(request.url()).pathname !== '/api/v1/me') return;
      void request.allHeaders().then((headers) => {
        authorizationHeader = headers.authorization;
        requestOrigin = headers.origin;
      }).catch(() => undefined);
    });
    popup.on('response', (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname === '/api/v1/me') meResponseStatus = response.status();
      if (pathname === '/api/v1/jobs/capture') captureResponseStatus = response.status();
    });
    await popup.goto(`chrome-extension://${extensionId}/index.html`);
    await popup.waitForTimeout(3000);
    console.log(`EXTENSION_POPUP_TEXT=${(await popup.locator('body').innerText()).slice(0, 300)}`);
    const status = popup.getByRole('status').first();
    if (await status.count()) await expect(status).not.toHaveText('Checking account…', { timeout: 20_000 });
    const accountStatus = (await status.textContent())?.trim() ?? '';
    console.log(`EXTENSION_ACCOUNT_STATUS=${accountStatus}`);
    console.log(`EXTENSION_REQUEST_ORIGIN=${requestOrigin ?? 'missing'}`);
    if (meResponseStatus !== 200)
      throw new Error('The extension account request did not return HTTP 200.');
    if (accountStatus !== testUser.emailAddress[0])
      throw new Error('The extension did not display the signed-in test email.');

    stage = 'capturing-job-page';
    const jobPage = await context.newPage();
    await jobPage.goto(`${baseUrl}/workspace`);
    await jobPage.setContent(`<!doctype html><html><head><title>Senior Product Designer</title></head><body><main><h1>Senior Product Designer</h1><p>${'Design and improve core product experiences with research, prototyping, and close collaboration across product and engineering teams. '.repeat(4)}</p></main></body></html>`);
    await jobPage.bringToFront();
    await popup.getByRole('button', { name: 'Read this job page' }).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(popup.getByLabel('Role title')).toHaveValue('Senior Product Designer');
    await expect(popup.getByLabel('Job description')).toContainText('Design and improve core product experiences');
    await popup.getByLabel('Company').fill('Proof Company');
    await popup.getByRole('button', { name: 'Save this role' }).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(popup.getByRole('status').last()).toHaveText('Role saved to your workspace.', { timeout: 20_000 });
    if (captureResponseStatus !== 200)
      throw new Error('The extension capture request did not return HTTP 200.');
    const roleLink = popup.getByRole('link', { name: 'Open saved role' });
    await expect(roleLink).toBeVisible();
    const savedRoleUrl = await roleLink.getAttribute('href');
    if (!savedRoleUrl || !/^http:\/\/localhost:3002\/workspace\/roles\//.test(savedRoleUrl))
      throw new Error('The extension did not provide the saved role link.');
    await jobPage.goto(savedRoleUrl);
    await expect(jobPage).toHaveURL(/\/workspace\/roles\//);
    console.log('EXTENSION_CAPTURE_SAVE_OPEN=passed');
    await popup.screenshot({ path: resolve(tmpdir(), 'career-workspace-extension-popup.png') });

    if (!authorizationHeader?.startsWith('Bearer '))
      throw new Error('The extension request did not include a bearer token.');
    const state = await clerk.authenticateRequest(
      new Request(`${baseUrl}/api/v1/me`, { headers: { authorization: authorizationHeader } }),
      { authorizedParties: [
        `chrome-extension://${extensionId}`,
        baseUrl,
      ] },
    );
    console.log(`CLERK_AUTHENTICATED=${state.isAuthenticated}`);
    console.log(`CLERK_AUTH_REASON=${state.reason ?? 'none'}`);
    if (!state.isAuthenticated)
      throw new Error('Clerk did not authenticate the extension bearer token.');
    console.log('EXTENSION_API_ROUNDTRIP=passed');
  } finally {
    stage = 'cleanup';
    const failures: string[] = [];
    try {
      await context?.close();
    } catch {
      failures.push('browser');
    }
    if (clerkId) {
      try {
        const database = getDatabase();
        const [localUser] = await database
          .select({ id: users.id })
          .from(users)
          .where(eq(users.clerkId, clerkId));
        if (localUser) {
          await database
            .delete(ledgerEntries)
            .where(eq(ledgerEntries.userId, localUser.id));
          await database.delete(users).where(eq(users.id, localUser.id));
        }
      } catch {
        failures.push('database-user');
      }
      try {
        await clerk.users.deleteUser(clerkId);
      } catch {
        failures.push('clerk-user');
      }
    }
    try {
      await closeDatabase();
    } catch {
      failures.push('database-connection');
    }
    try {
      await rm(profile, { recursive: true, force: true });
    } catch {
      failures.push('browser-profile');
    }
    if (failures.length) {
      console.error(`EXTENSION_CLEANUP_FAILED=${failures.join(',')}`);
      throw new Error('Extension proof cleanup failed.');
    }
  }
}

void runProof().catch((error) => {
  console.log(`EXTENSION_PROOF_STAGE=${stage}`);
  console.log(`EXTENSION_PROOF_ERROR=${error instanceof Error ? error.name : 'unknown'}`);
  process.exitCode = 1;
});
