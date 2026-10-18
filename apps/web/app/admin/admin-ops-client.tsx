'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import styles from './admin-ops.module.css';

type Suppression = { id: string; reason: string; createdAt: string };
type FailedTask = {
  id: string;
  userId: string;
  kind: string;
  attempts: number;
  error: string | null;
  updatedAt: string;
};
type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string } };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    cache: 'no-store',
  });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok)
    throw new Error(
      body.error?.message ?? 'The request could not be completed.',
    );
  return body.data as T;
}

export function AdminSuppressions() {
  const [items, setItems] = useState<Suppression[]>([]);
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await request<Suppression[]>('/api/v1/admin/suppressions'));
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The list could not load.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request<Suppression>('/api/v1/admin/suppressions', {
        method: 'POST',
        body: JSON.stringify({ email, reason }),
      });
      setEmail('');
      setReason('');
      setNotice(
        'Address added to the do-not-contact list. The email itself is not stored.',
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The address could not be added.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request<{ id: string }>(`/api/v1/admin/suppressions/${id}`, {
        method: 'DELETE',
      });
      setPendingRemoval(null);
      setNotice(
        'Address removed. Future outreach to it will no longer be blocked by this list.',
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The address could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <a href="/admin">← Administration</a>
      <h1>Do-not-contact list</h1>
      <p>
        Adding an address blocks email reveal and outreach drafting. We keep a
        one-way hash, not the email address.
      </p>
      {error && (
        <div>
          <p className={styles.error} role="alert">
            {error}
          </p>
          {!loading && (
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <section
        className={styles.section}
        aria-labelledby="add-suppression-title"
      >
        <h2 id="add-suppression-title">Block an address</h2>
        <form className={styles.form} onSubmit={(event) => void add(event)}>
          <label>
            Email address
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={320}
            />
          </label>
          <label>
            Reason
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              maxLength={500}
              rows={3}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Add to list'}
          </button>
        </form>
      </section>
      <section
        className={styles.section}
        aria-labelledby="suppression-list-title"
      >
        <h2 id="suppression-list-title">Blocked addresses</h2>
        {loading ? (
          <p role="status">Loading the list…</p>
        ) : items.length === 0 ? (
          <p>No blocked addresses yet.</p>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>Private address hash</strong>
                  <p>{item.reason}</p>
                  <small>
                    Added {new Date(item.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  </small>
                </div>
                {pendingRemoval === item.id ? (
                  <div className={styles.confirm}>
                    <p>
                      Remove this block? Outreach to this address will be
                      allowed again.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(item.id)}
                    >
                      Confirm removal
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setPendingRemoval(null)}
                    >
                      Keep blocked
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPendingRemoval(item.id)}
                  >
                    Remove block
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export function AdminFailedTasks() {
  const [items, setItems] = useState<FailedTask[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await request<FailedTask[]>('/api/v1/admin/tasks'));
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Failed tasks could not load.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function retry(event: FormEvent<HTMLFormElement>, task: FailedTask) {
    event.preventDefault();
    setBusy(task.id);
    setError('');
    setNotice('');
    try {
      await request<{ task: FailedTask; workflowRunId: string }>(
        `/api/v1/admin/tasks/${task.id}/retry`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: reasons[task.id]?.trim() }),
        },
      );
      setNotice('Retry started. The internal event records your reason.');
      setReasons((current) => ({ ...current, [task.id]: '' }));
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'This task could not be retried.',
      );
      await load();
    } finally {
      setBusy('');
    }
  }

  return (
    <main className={styles.page}>
      <a href="/admin">← Administration</a>
      <h1>Failed tasks</h1>
      <p>
        Only free searches, CV extraction and no-op checks can be retried here.
        Publishing tasks need a provider check first.
      </p>
      {error && (
        <div>
          <p className={styles.error} role="alert">
            {error}
          </p>
          {!loading && (
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading failed tasks…</p>
      ) : items.length === 0 ? (
        <p>No failed tasks need attention.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((task) => {
            const safe = [
              'noop',
              'cv_extract',
              'contacts_search',
              'account_delete',
            ].includes(task.kind);
            return (
              <li key={task.id}>
                <div className={styles.taskDetails}>
                  <h2>{task.kind.replaceAll('_', ' ')}</h2>
                  <p>Task {task.id}</p>
                  <p>User {task.userId}</p>
                  <p>
                    Failure: {task.error ?? 'No failure code recorded'} ·
                    Attempts: {task.attempts}
                  </p>
                  <small>
                    Last updated {new Date(task.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  </small>
                </div>
                {safe ? (
                  <form
                    className={styles.form}
                    onSubmit={(event) => void retry(event, task)}
                  >
                    <label>
                      Reason for retry
                      <input
                        value={reasons[task.id] ?? ''}
                        onChange={(event) =>
                          setReasons((current) => ({
                            ...current,
                            [task.id]: event.target.value,
                          }))
                        }
                        required
                        minLength={8}
                        maxLength={500}
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={
                        busy === task.id ||
                        (reasons[task.id]?.trim().length ?? 0) < 8
                      }
                    >
                      {busy === task.id ? 'Starting…' : 'Retry task'}
                    </button>
                  </form>
                ) : (
                  <p className={styles.caution}>
                    Retry disabled. Check the provider’s status and reconcile
                    before retrying.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
