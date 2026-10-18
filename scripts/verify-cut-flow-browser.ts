import { readFile, writeFile } from 'node:fs/promises';
import { createDatabase, users } from '../packages/db/src/index';
import { chromium, expect } from '@playwright/test';
import { clerkSetup, setupClerkTestingToken } from '@clerk/testing/playwright';

const cvPath = process.env.CV_PATH;
if (!cvPath) throw new Error('Set CV_PATH to a CV you approve for testing.');
let activeStep = 'configuration';
const statePath =
  process.env.CUT_FLOW_STATE_FILE ?? 'output/cut-flow-check/state.json';
const resumeDownloads = process.env.CUT_FLOW_RESUME_DOWNLOADS === 'true';

async function main() {
  const rawEnv = await readFile('apps/web/.env.local', 'utf8');
  const env = (name: string) =>
    rawEnv
      .match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '') ?? '';
  const secret = env('CLERK_SECRET_KEY');
  const publishable = env('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  const testDatabaseUrl =
    process.env.DATABASE_TEST_URL ||
    env('DATABASE_TEST_URL') ||
    'postgresql://localhost:5432/career_workspace_test';
  if (!secret.startsWith('sk_test_') || !publishable.startsWith('pk_test_'))
    throw new Error('Development Clerk configuration is required.');
  if (
    !testDatabaseUrl ||
    new URL(testDatabaseUrl).pathname !== '/career_workspace_test'
  )
    throw new Error('The isolated career_workspace_test database is required.');
  process.env.CLERK_SECRET_KEY = secret;
  process.env.CLERK_PUBLISHABLE_KEY = publishable;
  await clerkSetup();

  const base = process.argv[2] ?? 'http://localhost:3001';
  if (new URL(base).origin !== 'http://localhost:3001')
    throw new Error('This check is restricted to localhost:3001.');

  async function clerk(path: string, method: string, body?: unknown) {
    const response = await fetch(`https://api.clerk.com/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`Clerk request failed (${response.status}).`);
    return response.status === 204 ? {} : response.json();
  }

  const savedState = resumeDownloads
    ? JSON.parse(await readFile(statePath, 'utf8'))
    : null;
  const candidates: any[] = await clerk('users?limit=100', 'GET');
  const { database, pool } = createDatabase(testDatabaseUrl);
  let user: any;
  try {
    const existing = new Set(
      (await database.select({ clerkId: users.clerkId }).from(users)).map(
        (row) => row.clerkId,
      ),
    );
    user = candidates.find(
      (candidate) =>
        /^cw_(e2e|chat|live|test|cut|auth)/.test(candidate.username ?? '') &&
        (savedState
          ? candidate.id === savedState.clerkId
          : !existing.has(candidate.id)) &&
        (!process.env.CLERK_TEST_USER_ID ||
          candidate.id === process.env.CLERK_TEST_USER_ID),
    );
  } finally {
    await pool.end();
  }
  if (!user)
    throw new Error(
      'An existing Clerk test identity unused by career_workspace_test is required. Create one in the development Clerk dashboard with a cw_test_ username.',
    );

  const browser = await chromium.launch();
  let sessionId: string | undefined;
  let completedSteps = 0;
  const passed = () => {
    completedSteps += 1;
    console.log(`PASS ${completedSteps}: ${activeStep}`);
  };
  let groundingResponses = 0;
  let groundingFlagCount: number | null = null;

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    page.on('response', async (response) => {
      if (!/\/api\/v1\/resumes\/[^/]+\/grounding(?:\?|$)/.test(response.url()))
        return;
      try {
        const body = await response.json();
        const grounding = body?.data;
        if (!response.ok() || !grounding) return;
        groundingFlagCount =
          (Array.isArray(grounding.flags) ? grounding.flags.length : 0) +
          (Array.isArray(grounding.items)
            ? grounding.items.reduce(
                (count: number, item: any) =>
                  count + (Array.isArray(item.flags) ? item.flags.length : 0),
                0,
              )
            : 0);
        groundingResponses += 1;
      } catch {
        // Keep response bodies, including CV text, out of script output.
      }
    });
    await setupClerkTestingToken({ page });
    activeStep = 'sign-in';
    const ticket: any = await clerk('sign_in_tokens', 'POST', {
      user_id: user.id,
      expires_in_seconds: 120,
    });
    await page.goto(base + '/sign-in');
    await page.waitForFunction(() => Boolean((window as any).Clerk));
    sessionId = await page.evaluate(async (token) => {
      const clerk = (window as any).Clerk;
      await clerk.load();
      const attempt = await clerk.client.signIn.create({
        strategy: 'ticket',
        ticket: token,
      });
      if (!attempt.createdSessionId)
        throw new Error('Sign-in did not complete.');
      await clerk.setActive({ session: attempt.createdSessionId });
      return attempt.createdSessionId as string;
    }, ticket.token);
    await page.goto(base + '/auth/complete');
    await expect(page).toHaveURL(/\/workspace$/, { timeout: 30_000 });
    passed();

    let title = '',
      company = '',
      approvals = 0;
    let flagCount = savedState?.flagCount ?? 0;
    let resumeUrl = savedState?.resumeUrl ?? '';
    if (!savedState) {
      const marker = `cut-${Date.now().toString(36)}`;
      title = `Security Researcher ${marker}`;
      company = `PortSwigger ${marker}`;
      activeStep = 'role and live fit review';
      await page.goto(base + '/workspace?view=roles&add=1');
      await page.getByLabel('Job title').fill(title);
      await page.getByLabel('Company', { exact: true }).fill(company);
      await page.getByLabel('Location (optional)').fill('Remote');
      await page
        .getByLabel('Role link (optional)')
        .fill(
          `https://portswigger.net/careers?check=${encodeURIComponent(marker)}`,
        );
      await page
        .getByLabel('Or paste the role description')
        .fill(
          `We are seeking a security researcher to investigate web application security, explain vulnerabilities clearly, and work with engineering teams on practical fixes. The role involves security testing, responsible disclosure, technical writing, and collaboration across product teams. Applicants should describe relevant experience and evidence in their own application materials. Reference ${marker}.`,
        );
      await page.getByRole('button', { name: 'Save role · 1 credit' }).click();
      await expect(
        page.getByText(
          'Fit review saved. Read the gaps and open questions before preparing.',
        ),
      ).toBeVisible({ timeout: 90_000 });
      await expect(
        page.getByRole('heading', { name: title, exact: true }),
      ).toBeVisible();
      passed();

      activeStep = 'application preparation';
      await page
        .getByRole('button', {
          name: 'Prepare this application · CV 3 credits',
        })
        .click();
      await expect(page).toHaveURL(
        /\/workspace\/roles\/[^/]+\/resume\?prepare=1/,
        { timeout: 30_000 },
      );
      await expect(
        page.getByRole('region', { name: 'CV upload and fact review' }),
      ).toBeVisible({ timeout: 30_000 });
      passed();

      activeStep = 'CV upload and fact extraction';
      await page.getByLabel('Choose a CV file').setInputFiles({
        name: 'candidate-cv.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: await readFile(cvPath!),
      });
      await page
        .getByRole('button', { name: 'Upload CV', exact: true })
        .click();
      await expect(page.getByText(/facts are ready to review/i)).toBeVisible({
        timeout: 120_000,
      });
      const factArticles = page.locator(
        'section[aria-labelledby="facts-heading"] article',
      );
      await expect(factArticles.first()).toBeVisible();
      passed();

      activeStep = 'fact review';
      approvals = 0;
      const approveButtons = factArticles.getByRole('button', {
        name: 'Approve',
        exact: true,
      });
      while (await approveButtons.count()) {
        const remaining = await approveButtons.count();
        if (approvals >= 200)
          throw new Error('Fact review exceeded the safety limit.');
        await approveButtons.first().click();
        // Wait for this card's update before resolving the next live locator.
        await expect(approveButtons).toHaveCount(remaining - 1, {
          timeout: 30_000,
        });
        approvals += 1;
      }
      if (approvals === 0)
        throw new Error('The CV upload did not produce facts needing review.');
      await expect(
        factArticles.getByText('proposed', { exact: true }),
      ).toHaveCount(0, { timeout: 30_000 });
      activeStep = 'live CV draft';
      await page
        .getByRole('button', { name: 'Continue & draft CV · 3 credits' })
        .click();
      await expect(page.getByLabel('CV approval')).toBeVisible({
        timeout: 180_000,
      });
      await expect
        .poll(() => groundingResponses, { timeout: 30_000 })
        .toBeGreaterThan(0);
      passed();

      const name = page.getByLabel('Name', { exact: true });
      const contact = page.getByLabel('Contact details (email or phone)');
      await name.fill('Alex Test');
      await contact.fill('test@example.test');
      if (groundingFlagCount === null)
        throw new Error('Grounding response missing.');
      flagCount = groundingFlagCount;
      // Grounding flags are counted from the structured response; claim text stays private.
      if (flagCount)
        throw new Error(
          'The draft needs a truthful claim review before approval.',
        );
      activeStep = 'header save and approval';
      await page
        .getByRole('button', { name: 'Save new version', exact: true })
        .click();
      await expect(page.getByText(/Saved as CV version/)).toBeVisible({
        timeout: 60_000,
      });
      await page
        .getByRole('checkbox', {
          name: 'I checked my name and contact details, and that each CV line matches its supporting facts.',
        })
        .check();
      await page
        .getByRole('button', { name: 'Approve & download PDF', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'CV approved', exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      passed();

      resumeUrl = page.url();
      await writeFile(
        statePath,
        JSON.stringify({
          clerkId: user.id,
          title,
          company,
          approvals,
          flagCount,
          resumeUrl,
        }),
        { mode: 0o600 },
      );
    } else {
      ({ title, company, approvals } = savedState);
      if (!resumeUrl.startsWith(base + '/workspace/roles/'))
        throw new Error('Invalid local resume checkpoint.');
      console.log(
        'Continuing from the approved CV checkpoint; no AI requests will be made.',
      );
    }

    activeStep = 'first download from My documents creates the check-in';
    await page.goto(base + '/workspace?view=documents');
    const firstDocumentRow = page.getByRole('row').filter({ hasText: title });
    await expect(firstDocumentRow).toBeVisible({ timeout: 30_000 });
    const firstDocumentDownload = page.waitForEvent('download');
    void firstDocumentDownload.catch(() => undefined);
    const firstHandoffResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/application-handoffs') &&
        response.request().method() === 'POST',
    );
    void firstHandoffResponse.catch(() => undefined);
    await firstDocumentRow
      .getByRole('button', { name: /^Download (?:approved v\d+ )?PDF$/ })
      .click();
    await firstDocumentDownload;
    const firstHandoff = await firstHandoffResponse;
    expect(firstHandoff.status()).toBe(200);
    expect(['created', 'existing']).toContain(
      (await firstHandoff.json()).data.outcome,
    );
    await expect(firstDocumentRow.getByRole('status')).toContainText(
      'Your application check-in is ready',
      { timeout: 30_000 },
    );
    passed();
    await page.goto(resumeUrl);

    activeStep = 'approved PDF download';
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download approved PDF', exact: true })
      .click();
    await download;
    await expect(
      page.getByRole('button', {
        name: 'Open employer application',
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
    passed();

    activeStep = 'employer link and application check-in';
    const employerTab = page.waitForEvent('popup');
    await page
      .getByRole('button', { name: 'Open employer application', exact: true })
      .click();
    const popup = await employerTab;
    await expect(popup).toHaveURL(
      /^https:\/\/portswigger\.net\/careers(?:[/?#]|$)/,
      { timeout: 30_000 },
    );
    await popup.close();
    await page.goto(base + '/workspace');
    await expect(
      page.getByRole('heading', {
        name: `Did you apply to ${title} at ${company}?`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole('button', { name: 'Yes, I applied', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'is marked applied.' }),
    ).toBeVisible({ timeout: 30_000 });
    passed();

    activeStep = 'My documents download after Applied';
    await page.goto(base + '/workspace?view=documents');
    const documentRow = page.getByRole('row').filter({ hasText: title });
    await expect(documentRow).toBeVisible({ timeout: 30_000 });
    const repeatedDownload = page.waitForEvent('download');
    await documentRow
      .getByRole('button', { name: /^Download (?:approved v\d+ )?PDF$/ })
      .click();
    await repeatedDownload;
    await expect(documentRow.getByRole('status')).toContainText(
      'no new check-in was created',
      { timeout: 30_000 },
    );
    await expect(documentRow.getByRole('alert')).toHaveCount(0);
    await expect(
      documentRow.getByRole('button', { name: /Retry/ }),
    ).toHaveCount(0);
    passed();

    console.log(
      `${resumeDownloads ? 'Remaining cut-flow steps passed' : 'Live cut-flow passed'}: ${completedSteps} steps; ${approvals} facts approved; ${flagCount} grounding flags.`,
    );
  } finally {
    try {
      await browser.close();
    } finally {
      if (sessionId) {
        try {
          await clerk(`sessions/${sessionId}/revoke`, 'POST');
        } catch {
          console.error('Session revocation failed.');
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(
    'Failure kind:',
    error?.name ?? 'unknown',
    String(error?.stack ?? '').match(
      /verify-cut-flow-browser.ts:\d+:\d+/,
    )?.[0] ?? '',
  );
  console.error(
    `Live cut-flow stopped during ${activeStep}; no CV text, claim wording, or sign-in data was printed.`,
  );
  process.exitCode = 1;
});
