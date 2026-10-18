'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DiscoveryFeed } from '@career-workspace/contracts';
import { Button, FitBandBadge } from '../../../components/workspace';
import { activationApi } from './activation-flow';
import styles from './activation.module.css';

export default function MatchesPanel() {
  const router = useRouter();
  const [feed, setFeed] = useState<DiscoveryFeed | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [poll, setPoll] = useState(0);
  const [refreshTask, setRefreshTask] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError('');
    try {
      setFeed(await activationApi<DiscoveryFeed>('/api/v1/discovery'));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load matches.',
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!refreshTask) return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const task = await activationApi<{ status: string }>(
          `/api/v1/tasks/${refreshTask}`,
        );
        if (stopped) return;
        if (task.status === 'succeeded' || task.status === 'failed') {
          setRefreshTask(null);
          setBusy('');
          setNote(
            task.status === 'succeeded'
              ? 'Collected roles updated.'
              : 'The refresh could not finish. Existing collected matches are still available.',
          );
          await load();
        } else setPoll((value) => value + 1);
      } catch {
        if (!stopped) {
          setRefreshTask(null);
          setBusy('');
          setError('Could not check the refresh. Try loading matches again.');
        }
      }
    }, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refreshTask, load, poll]);
  async function refresh() {
    setBusy('refresh');
    setError('');
    try {
      const result = await activationApi<{
        task: { id: string; status: string };
      }>('/api/v1/discovery/refresh', { method: 'POST' });
      setNote('Collecting open roles. You can keep browsing.');
      if (result.task.status === 'succeeded') {
        setBusy('');
        await load();
      } else setRefreshTask(result.task.id);
    } catch (cause) {
      setBusy('');
      setError(
        cause instanceof Error ? cause.message : 'Could not refresh matches.',
      );
    }
  }
  async function save(id: string) {
    setBusy(id);
    setError('');
    try {
      const result = await activationApi<{ opportunity: { id: string } }>(
        `/api/v1/discovery/${id}/save`,
        { method: 'POST' },
      );
      router.push(`/workspace/roles/${result.opportunity.id}`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save this role.',
      );
    } finally {
      setBusy('');
    }
  }
  return (
    <section
      id="home-matches"
      className={styles.matches}
      aria-label="Open roles for you"
    >
      <header>
        <h2>Open roles for you</h2>
        <Link href="/workspace/profile">Change preferences</Link>
      </header>
      <p>
        {feed?.profileReady
          ? 'Ranked against your confirmed CV facts and role preferences.'
          : 'Matched to the role you want. Add a CV when you are ready for a personal fit review.'}{' '}
        These are collected listings; check the employer’s page before applying.
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Link href="/workspace?view=roles&add=1">Paste a job instead</Link>
          <Button variant="text" onClick={() => void load()}>
            Try matches again
          </Button>
        </div>
      )}
      {!feed && !error && <p role="status">Finding your collected matches…</p>}
      {feed &&
        (feed.matches.length ? (
          <ol className={styles.list}>
            {feed.matches
              .slice(0, 5)
              .map(({ job, reasons, savedOpportunityId, fitBand }) => (
                <li className={styles.match} key={job.id}>
                  <h3>{job.title}</h3>
                  <FitBandBadge band={fitBand} />
                  <p>
                    {job.company} · {job.location || 'Location not listed'}
                  </p>
                  <p>
                    <strong>Why this matches:</strong>{' '}
                    {reasons.slice(0, 3).join('; ')}
                  </p>
                  <div className={styles.actions}>
                    {savedOpportunityId ? (
                      <Link href={`/workspace/roles/${savedOpportunityId}`}>
                        Open saved role
                      </Link>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={Boolean(busy)}
                        onClick={() => void save(job.id)}
                      >
                        {busy === job.id ? 'Saving…' : 'Save role'}
                      </Button>
                    )}
                    <a href={job.url} target="_blank" rel="noreferrer">
                      View employer listing
                    </a>
                  </div>
                </li>
              ))}
          </ol>
        ) : (
          <div className={styles.match}>
            <h3>No collected roles match yet</h3>
            <p>
              We do not have an open listing that matches your CV or chosen role
              in the current pool. Try another target role or paste a job you
              have found.
            </p>
            <div className={styles.actions}>
              <Link href="/workspace?view=roles&add=1">Paste a job</Link>
              <Link href="/workspace?setup=role">Choose another role</Link>
            </div>
          </div>
        ))}
      <details>
        <summary>Update collected roles</summary>
        <p>Collection runs daily. You can also request a refresh.</p>
        <Button
          variant="text"
          disabled={Boolean(busy)}
          onClick={() => void refresh()}
        >
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh collected roles'}
        </Button>
        <p><Link href="/workspace/discover">See all matches and collection status</Link></p>
        {note && <p role="status">{note}</p>}
      </details>
    </section>
  );
}
