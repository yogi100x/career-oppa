import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, open, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.includes('--help')) {
  console.log(
    'CV_PATH=/private/path/cv.docx LIVE_AI_CHECK=true pnpm verify:cut-flow\nStarts an isolated localhost:3001 app using career_workspace_test, real Clerk test tickets and live AI (cumulative $0.25 guard). No Google automation or external application submission.',
  );
  process.exit(0);
}
if (process.env.LIVE_AI_CHECK !== 'true' || !process.env.CV_PATH)
  throw new Error(
    'Explicit LIVE_AI_CHECK=true and CV_PATH are required; use --help.',
  );
await readFile(process.env.CV_PATH);
const env = { ...process.env };
for (const line of (
  await readFile(resolve(root, 'apps/web/.env.local'), 'utf8')
).split('\n')) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match && env[match[1]] === undefined)
    env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
}
const databaseUrl =
  env.DATABASE_TEST_URL || 'postgresql://localhost:5432/career_workspace_test';
const database = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.pathname !== '/career_workspace_test'
)
  throw new Error('Only the local career_workspace_test database is allowed.');
if (
  !env.CLERK_SECRET_KEY?.startsWith('sk_test_') ||
  !env.OPENROUTER_API_KEY ||
  env.OPENROUTER_API_KEY.startsWith('REPLACE_')
)
  throw new Error(
    'Development Clerk and a live OpenRouter key must be configured.',
  );
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(3001, () => probe.close(resolve));
});
const output = resolve(root, 'output/cut-flow-check');
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);
const budget = resolve(
  env.CUT_FLOW_BUDGET_FILE || resolve(output, 'budget.json'),
);
try {
  await writeFile(
    budget,
    JSON.stringify({
      reserved: 0,
      requests: 0,
      responses: 0,
      actualCost: 0,
      costReported: 0,
    }),
    { flag: 'wx', mode: 0o600 },
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const state = JSON.parse(await readFile(budget, 'utf8'));
if (
  !Number.isFinite(state.reserved) ||
  state.reserved < 0 ||
  state.reserved >= 0.25
)
  throw new Error(
    'Budget ledger invalid or exhausted. Do not reset it without a new spending allowance.',
  );
const log = await open(resolve(output, 'server.log'), 'w', 0o600);
const server = spawn('pnpm', ['--filter', '@career-workspace/web', 'dev'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', log.fd, log.fd],
  env: {
    ...env,
    PORT: '3001',
    DATABASE_URL: databaseUrl,
    DATABASE_TEST_URL: databaseUrl,
    NEXT_DIST_DIR: '.next-cut',
    STORAGE_DRIVER: 'local',
    ALLOW_LOCAL_STORAGE_FOR_TESTS: 'true',
    STORAGE_LOCAL_DIR: resolve(output, 'storage'),
    CUT_FLOW_BUDGET_FILE: budget,
    NODE_OPTIONS: `--import=${resolve(root, 'scripts/cut-flow-budget-guard.mjs')}`,
  },
});
let browser;
const stop = () => {
  browser?.kill('SIGTERM');
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {}
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null)
      throw new Error('Test server stopped; inspect the private server log.');
    try {
      const response = await fetch('http://localhost:3001/sign-in', {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Test server did not become ready.');
  browser = spawn(
    'pnpm',
    ['exec', 'tsx', 'scripts/verify-cut-flow-browser.ts'],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...env, DATABASE_TEST_URL: databaseUrl },
    },
  );
  const code = await new Promise((resolve, reject) => {
    browser.once('error', reject);
    browser.once('exit', resolve);
  });
  if (code !== 0) throw new Error('Browser flow did not complete.');
} finally {
  stop();
  await log.close();
}
