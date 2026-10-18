# Career-Oppa

A career workspace for students and early-career applicants: add a CV or a target role, see open roles that fit, review a role with an evidence-based fit score, tailor a CV from confirmed facts, and get coaching on the web and in Telegram.

Built with Next.js, TypeScript, Postgres (Drizzle), Clerk, Vercel Workflow and the Vercel AI SDK.

## Layout

- `apps/web`: the web app and API routes
- `apps/extension`: browser extension that captures a job page
- `packages/core`, `packages/db`, `packages/adapters`, `packages/contracts`, `packages/pdf`: shared logic, schema and migrations, AI and job-source adapters, API types, CV rendering

## Development

Use Node 22 and pnpm. Copy each `.env.example` to `.env.local` and fill in your own keys. Then:

```
pnpm install
pnpm lint
pnpm typecheck
DATABASE_TEST_URL=postgresql://localhost:5432/career_workspace_test pnpm test
```

Tests use only a database named `career_workspace_test`.

## Licence

GNU Affero General Public License v3.0. See `LICENSE`. If you run a modified version as a network service, you must offer its source to its users.
