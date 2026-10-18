'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import styles from './admin-ops.module.css';

type Submission = {
  id: string;
  userId: string;
  url: string;
  status: string;
  reason: string | null;
  submittedAt: string;
};
type AdminUser = {
  id: string;
  clerkId: string;
  role: string;
  createdAt: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body?.error?.message ?? 'The request could not be completed.',
    );
  return body.data as T;
}

export function RewardQueue() {
  const [items, setItems] = useState<Submission[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api<Submission[]>('/api/v1/admin/rewards'));
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load the queue.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function decide(
    id: string,
    decision: 'approve' | 'reject',
    reason?: string,
  ) {
    setBusy(id);
    setError('');
    setNotice('');
    try {
      const result = await api<{ granted: boolean; credits: number }>(
        `/api/v1/admin/rewards/${id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(
            decision === 'reject' ? { decision, reason } : { decision },
          ),
        },
      );
      await load();
      setNotice(
        decision === 'approve'
          ? result.granted
            ? `Approved. ${result.credits} earned credits were added.`
            : 'Approved. The monthly reward limit is already reached.'
          : 'Submission rejected.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not review submission.',
      );
    } finally {
      setBusy('');
    }
  }
  return (
    <section className={styles.page} aria-labelledby="reward-queue-title">
      <h1 id="reward-queue-title">Reward review queue</h1>
      <p>
        Approved eligible posts earn 10 credits, up to three rewards per month.
      </p>
      <section
        className={styles.section}
        aria-label="Pending reward submissions"
      >
        <h2>Submissions</h2>
        {error && (
          <div className={styles.error} role="alert">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
            >
              Try again
            </button>
          </div>
        )}
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        {loading ? (
          <p role="status">Loading reward submissions…</p>
        ) : items.length === 0 ? (
          error ? null : (
            <p>No submissions are waiting for review.</p>
          )
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.id}>
                <div className={styles.taskDetails}>
                  <h2>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      Open submitted post
                    </a>
                  </h2>
                  <p>
                    Submitted by <code>{item.userId}</code>
                  </p>
                  <small>
                    {new Date(item.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </small>
                </div>
                <div className={styles.reviewActions}>
                  <button
                    disabled={busy === item.id}
                    onClick={() => void decide(item.id, 'approve')}
                  >
                    Approve · 10 credits
                  </button>
                  <RejectForm
                    disabled={busy === item.id}
                    onReject={(reason) =>
                      void decide(item.id, 'reject', reason)
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function RejectForm({
  disabled,
  onReject,
}: {
  disabled: boolean;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <form
      className={styles.form}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (reason.trim()) onReject(reason.trim());
      }}
    >
      <label>
        Rejection reason{' '}
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
          maxLength={1000}
        />
      </label>
      <button disabled={disabled || !reason.trim()}>Reject</button>
    </form>
  );
}

export function UserLookup() {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  async function search(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    setUsers([]);
    try {
      setUsers(
        await api<AdminUser[]>(
          `/api/v1/admin/users?q=${encodeURIComponent(query)}`,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not search users.',
      );
    } finally {
      setSearched(true);
      setBusy(false);
    }
  }
  return (
    <section className={styles.page}>
      <h1>User lookup</h1>
      <p>Look up an account by its local ID or Clerk ID.</p>
      <section className={styles.section} aria-label="Search accounts">
        <form className={styles.form} onSubmit={(event) => void search(event)}>
          <label>
            Search by user ID or Clerk ID{' '}
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setError('');
              }}
              minLength={2}
              maxLength={120}
              required
            />
          </label>
          <button disabled={busy || query.trim().length < 2}>
            {busy ? 'Searching…' : error ? 'Retry search' : 'Search'}
          </button>
        </form>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {busy ? (
          <p role="status">Searching accounts…</p>
        ) : searched && !error && users.length === 0 ? (
          <p>No matching accounts.</p>
        ) : (
          users.length > 0 && (
            <ul className={styles.list}>
              {users.map((user) => (
                <li key={user.id}>
                  <div className={styles.taskDetails}>
                    <strong>{user.id}</strong>
                    <p>
                      Clerk ID: {user.clerkId} · Role: {user.role}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )
        )}
      </section>
    </section>
  );
}

export function LedgerAdjustment() {
  const [userId, setUserId] = useState('');
  const [bucket, setBucket] = useState('earned');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const key =
        idempotencyKey.current ||
        (idempotencyKey.current = crypto.randomUUID());
      const result = await api<{ replayed: boolean }>(
        '/api/v1/admin/ledger-adjustments',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify({
            userId,
            bucket,
            amount: Number(amount),
            reason,
          }),
        },
      );
      setNotice(
        result.replayed
          ? 'This adjustment was already applied.'
          : 'Credit adjustment saved and recorded.',
      );
      idempotencyKey.current = '';
      setAmount('');
      setReason('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save adjustment.',
      );
    } finally {
      setBusy(false);
    }
  }
  function changed(setValue: (value: string) => void, value: string) {
    idempotencyKey.current = '';
    setValue(value);
    setError('');
    setNotice('');
  }
  return (
    <section className={styles.page}>
      <h1>Credit adjustment</h1>
      <p>
        Use a positive amount to add credits or a negative amount to remove
        them. The reason is saved in the internal audit log.
      </p>
      <section className={styles.section} aria-label="New credit adjustment">
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <label>
            User ID{' '}
            <input
              value={userId}
              onChange={(event) => changed(setUserId, event.target.value)}
              required
            />
          </label>
          <label>
            Credit bucket{' '}
            <select
              value={bucket}
              onChange={(event) => changed(setBucket, event.target.value)}
            >
              <option value="free">Free</option>
              <option value="earned">Earned</option>
              <option value="purchased">Purchased</option>
            </select>
          </label>
          <label>
            Signed amount{' '}
            <input
              type="number"
              step="1"
              min="-100000"
              max="100000"
              value={amount}
              onChange={(event) => changed(setAmount, event.target.value)}
              required
            />
          </label>
          <label>
            Reason{' '}
            <textarea
              value={reason}
              onChange={(event) => changed(setReason, event.target.value)}
              required
              maxLength={1000}
            />
          </label>
          <button disabled={busy || Number(amount) === 0}>
            {busy ? 'Saving…' : error ? 'Retry save' : 'Save adjustment'}
          </button>
        </form>
        {busy && <p role="status">Saving the adjustment…</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
      </section>
    </section>
  );
}
