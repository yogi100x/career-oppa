import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  useAuth,
} from '@clerk/chrome-extension';
import './style.css';
import { captureActiveRolePage } from './capture';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  string | undefined;
const syncHost =
  (import.meta.env.VITE_SYNC_HOST as string | undefined) ??
  'http://localhost:3000';
const apiBaseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  'http://localhost:3000';

function AccountPanel() {
  const { getToken, isLoaded } = useAuth();
  const [label, setLabel] = React.useState('Checking account…');

  React.useEffect(() => {
    if (!isLoaded) return;
    let active = true;
    void (async () => {
      try {
        const token = await getToken();
        if (!token) {
          if (active) setLabel('Sign in on the web app to continue.');
          return;
        }
        const response = await fetch(`${apiBaseUrl}/api/v1/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body: unknown = await response.json();
        if (!active) return;
        if (!response.ok) {
          const code =
            typeof body === 'object' &&
            body !== null &&
            'error' in body &&
            typeof body.error === 'object' &&
            body.error !== null &&
            'code' in body.error
              ? body.error.code
              : undefined;
          setLabel(
            code === 'AGE_NOT_CONFIRMED'
              ? 'Confirm your age on the web app to continue.'
              : 'Could not load your account.',
          );
          return;
        }
        const email =
          typeof body === 'object' &&
          body !== null &&
          'data' in body &&
          typeof body.data === 'object' &&
          body.data !== null &&
          'email' in body.data &&
          typeof body.data.email === 'string'
            ? body.data.email
            : null;
        setLabel(email ?? 'Signed in to Career-Oppa');
      } catch {
        if (active) setLabel('Could not connect to Career-Oppa.');
      }
    })();
    return () => {
      active = false;
    };
  }, [getToken, isLoaded]);

  return <p role="status">{label}</p>;
}

function Popup() {
  return (
    <main>
      <h1>Career-Oppa</h1>
      <SignedIn>
        <AccountPanel />
        <CapturePanel />
      </SignedIn>
      <SignedOut>
        <p>Sign in on the web app to connect your account.</p>
      </SignedOut>
      <a href={syncHost} target="_blank" rel="noreferrer">
        Open Career-Oppa
      </a>
    </main>
  );
}

function CapturePanel() {
  const { getToken } = useAuth();
  const [draft, setDraft] = React.useState<{
    url: string;
    title: string;
    text: string;
  } | null>(null);
  const [company, setCompany] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [roleId, setRoleId] = React.useState<string | null>(null);
  async function readPage() {
    setBusy(true);
    setMessage('');
    setRoleId(null);
    try {
      setDraft(await captureActiveRolePage());
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'This page could not be read.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setMessage('');
    try {
      const token = await getToken();
      if (!token) {
        setMessage('Sign in on the web app to continue.');
        return;
      }
      const response = await fetch(`${apiBaseUrl}/api/v1/jobs/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...draft, company: company.trim() }),
      });
      const body = (await response.json()) as {
        data?: { opportunity?: { id?: string } };
        error?: { code?: string; message?: string };
      };
      if (!response.ok) {
        setMessage(
          body.error?.code === 'AGE_NOT_CONFIRMED'
            ? 'Confirm your age on the web app to save this role.'
            : (body.error?.message ??
                'The role could not be saved. Try again.'),
        );
        return;
      }
      const id = body.data?.opportunity?.id;
      if (!id) throw new Error('The server did not return a saved role.');
      setRoleId(id);
      setMessage('Role saved to your workspace.');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not connect to Career-Oppa.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Save a role">
      <button type="button" disabled={busy} onClick={() => void readPage()}>
        {busy ? 'Working…' : 'Read this job page'}
      </button>
      {draft && !roleId && (
        <form onSubmit={(event) => void save(event)}>
          <label>
            Role title
            <input
              required
              maxLength={200}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label>
            Company
            <input
              required
              maxLength={200}
              value={company}
              onChange={(event) => setCompany(event.target.value)}
            />
          </label>
          <label>
            Job description
            <textarea
              required
              minLength={120}
              maxLength={100000}
              rows={6}
              value={draft.text}
              onChange={(event) =>
                setDraft({ ...draft, text: event.target.value })
              }
            />
          </label>
          <p className="caption">Check the captured text before saving.</p>
          <button disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save this role'}
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
      {roleId && (
        <a
          href={`${syncHost}/workspace/roles/${encodeURIComponent(roleId)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open saved role
        </a>
      )}
    </section>
  );
}

if (!publishableKey)
  throw new Error(
    'Set VITE_CLERK_PUBLISHABLE_KEY before building the extension.',
  );

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={publishableKey}
      syncHost={syncHost}
      afterSignOutUrl={chrome.runtime.getURL('index.html')}
      signInFallbackRedirectUrl={chrome.runtime.getURL('index.html')}
      signUpFallbackRedirectUrl={chrome.runtime.getURL('index.html')}
    >
      <Popup />
    </ClerkProvider>
  </React.StrictMode>,
);
