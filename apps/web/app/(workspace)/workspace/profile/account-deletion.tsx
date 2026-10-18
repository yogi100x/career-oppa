'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../../../components/workspace';
import styles from './account-deletion.module.css';

type DeletionStatus = {
  taskId: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage: string | null;
  error: string | null;
} | null;
type ApiResponse<T> = { data?: T; error?: { code?: string; message?: string } };

async function requestDeletion() {
  return fetch('/api/v1/account/deletion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ confirmation: 'DELETE' }),
  });
}

function stageText(stage: string | null) {
  switch (stage) {
    case 'disconnect_provider_account':
    case 'delete_provider_profile':
      return 'disconnecting publishing accounts';
    case 'delete_private_files':
      return 'removing private files';
    case 'delete_clerk_identity':
      return 'removing sign-in details';
    case 'delete_local_account':
      return 'removing saved workspace data';
    default:
      return 'preparing account cleanup';
  }
}

export function AccountDeletionRequest() {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation !== 'DELETE' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await requestDeletion();
      const body = (await response.json()) as ApiResponse<unknown>;
      if (!response.ok)
        throw new Error(
          body.error?.code === 'ACCOUNT_DELETION_PENDING'
            ? 'Account cleanup is already in progress.'
            : body.error?.code === 'ACCOUNT_TASKS_IN_PROGRESS'
              ? 'Wait for your current background work to finish, then try again.'
              : 'We could not start account cleanup. Please try again.',
        );
      setAccepted(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'We could not start account cleanup. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="delete-account-title">
      <h2 id="delete-account-title">Delete your account</h2>
      <p>
        This removes your saved profile, projects, CVs, roles, contacts,
        messages, documents and publishing connection. Credit history is kept
        without identifying details. This cannot be undone.
      </p>
      <form className={styles.form} onSubmit={submit}>
        <label htmlFor="delete-account-confirmation">
          Type <strong>DELETE</strong> to confirm.
        </label>
        <input
          id="delete-account-confirmation"
          autoComplete="off"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          aria-describedby={error ? 'delete-account-error' : undefined}
        />
        {error && (
          <p className={styles.error} id="delete-account-error" role="alert">
            {error}
          </p>
        )}
        {accepted && (
          <p role="status">
            Deletion started. You’ll be signed out when cleanup finishes.
          </p>
        )}
        <Button
          variant="primary"
          type="submit"
          disabled={confirmation !== 'DELETE' || busy || accepted}
        >
          {busy
            ? 'Starting cleanup…'
            : accepted
              ? 'Deletion started'
              : 'Delete account'}
        </Button>
      </form>
    </section>
  );
}

export function AccountDeletionStatus() {
  const [status, setStatus] = useState<DeletionStatus | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  async function refresh() {
    const response = await fetch('/api/v1/account/deletion', {
      cache: 'no-store',
    });
    if (response.status === 401) {
      setStatus(null);
      setError(
        'Your sign-in has ended. If you requested account deletion, cleanup continues on the server.',
      );
      return;
    }
    const body = (await response.json()) as ApiResponse<DeletionStatus>;
    if (!response.ok)
      throw new Error('We could not check account cleanup status.');
    setStatus(body.data ?? null);
    setError(null);
  }

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        await refresh();
      } catch {
        if (!stopped)
          setError(
            'We could not check account cleanup status. Try again shortly.',
          );
      }
    };
    void poll();
    const interval = window.setInterval(() => {
      if (!stopped) void poll();
    }, 2500);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, []);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      const response = await requestDeletion();
      if (!response.ok)
        throw new Error(
          'We could not restart account cleanup. Please try again.',
        );
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'We could not restart account cleanup. Please try again.',
      );
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="deletion-status-title">
      <h1 id="deletion-status-title">Account cleanup</h1>
      {error ? (
        <p role="status">{error}</p>
      ) : status === undefined ? (
        <p role="status">Checking cleanup status…</p>
      ) : status?.status === 'failed' ? (
        <>
          <p className={styles.error}>
            We could not finish {stageText(status.stage)}. Your account is
            blocked while cleanup is retried.
          </p>
          <Button
            variant="primary"
            type="button"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? 'Restarting…' : 'Retry cleanup'}
          </Button>
        </>
      ) : status ? (
        <p role="status">
          We are {stageText(status.stage)}. This page will update as cleanup
          continues.
        </p>
      ) : (
        <p role="status">No pending account cleanup was found.</p>
      )}
    </section>
  );
}
