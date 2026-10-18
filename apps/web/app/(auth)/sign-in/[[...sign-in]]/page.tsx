import { isClerkConfigured } from '../../../../lib/clerk-config';
import AuthGate from '../../auth-gate';
import { sanitizeWorkspaceReturnPath } from '../../../../lib/workspace-return-path';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  if (!isClerkConfigured()) {
    return (
      <main className="auth-setup">
        <h1>Sign-in setup is waiting for Clerk keys</h1>
        <p>
          Add valid Clerk development keys to <code>apps/web/.env.local</code>,
          then reload this page.
        </p>
        <p>
          Keep the secret key on the server. The marketing page and design
          preview remain available while setup is incomplete.
        </p>
      </main>
    );
  }

  const { redirect_url: redirectUrl } = await searchParams;

  return (
    <main className="auth-page">
      <AuthGate
        mode="sign-in"
        returnTo={sanitizeWorkspaceReturnPath(redirectUrl)}
      />
    </main>
  );
}
