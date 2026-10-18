'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../../../components/workspace';
import styles from './rewards.module.css';
type Submission = {
  id: string;
  url: string;
  status: string;
  reason: string | null;
  creditsGranted: number;
  submittedAt: string;
};
export default function RewardsPanel() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [url, setUrl] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/v1/rewards', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error?.message ?? 'Reward submissions could not load.',
        );
      setSubmissions(body.data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Reward submissions could not load.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/rewards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, disclosureConfirmed: confirmed }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error?.message ?? 'This post could not be submitted.',
        );
      setUrl('');
      setConfirmed(false);
      await load();
      setNotice(
        'Post submitted for review. Credits are added only after approval.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'This post could not be submitted.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section id="earn" className={styles.panel} aria-labelledby="rewards-title">
      <h2 id="rewards-title">Earn credits by sharing your experience</h2>
      <p>
        Submit a public post about Career-Oppa for review. An approved post
        earns 10 credits, up to three approvals per calendar month (UTC). Your
        experience can be positive, mixed, or critical.
      </p>
      <p>
        Clearly tell readers that you may receive credits for the post.
        Submitting the same post again does not earn another reward.
      </p>
      <form onSubmit={submit} className={styles.form}>
        <label>
          Public post URL
          <input
            type="url"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
            maxLength={2048}
          />
        </label>
        <label className={styles.confirmation}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            required
          />
          I included a clear disclosure that I may receive Career-Oppa
          credits for this post.
        </label>
        <Button type="submit" disabled={saving || !confirmed || !url.trim()}>
          {saving ? 'Submitting…' : 'Submit for review — free'}
        </Button>
      </form>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => void load()}>
            Reload submissions
          </Button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p role="status">Loading your submissions…</p>
      ) : submissions.length ? (
        <ul className={styles.submissions}>
          {submissions.map((item) => (
            <li key={item.id}>
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                View submitted post
              </a>
              <strong>
                {item.status === 'approved'
                  ? item.creditsGranted
                    ? `Approved — ${item.creditsGranted} credits granted`
                    : 'Approved — monthly reward limit reached; no credits added'
                  : item.status === 'rejected'
                    ? 'Not approved'
                    : 'Waiting for review'}
              </strong>
              {item.reason && <p>{item.reason}</p>}
              <small>
                Submitted {new Date(item.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p>You have no reward submissions yet.</p>
      )}
    </section>
  );
}
