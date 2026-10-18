'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from './index';
import styles from './application-handoff-prompt.module.css';

type PendingHandoff = {
  id: string;
  opportunityId: string;
  source: 'approved_pdf' | 'employer_link';
  title: string;
  company: string;
};

type Envelope<T> = { data?: T; error?: { message?: string } };

async function readData<T>(response: Response): Promise<T> {
  const body = (await response.json()) as Envelope<T>;
  if (!response.ok || body.data === undefined)
    throw new Error(
      body.error?.message ?? 'This update could not be saved. Try again.',
    );
  return body.data;
}

export function ApplicationHandoffPrompt({
  onAnswered,
}: {
  onAnswered?: (opportunityId: string, answer: 'applied' | 'not_yet') => void;
} = {}) {
  const [pending, setPending] = useState<PendingHandoff[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [applied, setApplied] = useState<PendingHandoff | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/application-handoffs', {
        cache: 'no-store',
      });
      setPending(await readData<PendingHandoff[]>(response));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let away = false;
    const markAway = () => {
      away = true;
    };
    const refreshOnReturn = () => {
      if (away && document.visibilityState === 'visible') {
        away = false;
        void load();
      }
    };
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') markAway();
      else refreshOnReturn();
    };
    window.addEventListener('blur', markAway);
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      window.removeEventListener('blur', markAway);
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [load]);

  async function answer(answer: 'applied' | 'not_yet') {
    const item = pending[0];
    if (!item || working) return;
    setWorking(true);
    setMessage('');
    try {
      await readData(
        await fetch(`/api/v1/application-handoffs/${item.id}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer }),
        }),
      );
      setPending((items) => items.slice(1));
      onAnswered?.(item.opportunityId, answer);
      setApplied(answer === 'applied' ? item : null);
      setMessage(
        answer === 'applied'
          ? `${item.title} at ${item.company} is marked applied.`
          : `${item.title} at ${item.company} stays in preparation. You can update it when you’re ready.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'This update could not be saved. Try again.',
      );
    } finally {
      setWorking(false);
    }
  }

  if (!loaded) return null;
  if (loadError)
    return (
      <div className={styles.notice} role="status">
        Your application check-in could not load.{' '}
        <Button onClick={() => void load()}>Try again</Button>
      </div>
    );
  if (pending.length === 0)
    return message ? (
      <p className={styles.notice} role="status">
        {message}
        {applied && (
          <>
            {' '}
            Nice work. Want to message someone at {applied.company}?{' '}
            <a href={`/workspace/roles/${applied.opportunityId}#role-contacts`}>
              Find a contact (search is free)
            </a>
          </>
        )}
      </p>
    ) : null;
  const item = pending[0];

  return (
    <section
      className={styles.prompt}
      aria-labelledby="application-handoff-title"
    >
      <h2 id="application-handoff-title">
        Did you apply to {item.title} at {item.company}?
      </h2>
      <p>Your role stays in preparation until you confirm that you applied.</p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={working}
          onClick={() => void answer('applied')}
        >
          Yes, I applied
        </Button>
        <Button disabled={working} onClick={() => void answer('not_yet')}>
          Not yet
        </Button>
      </div>
      {message && (
        <p className={styles.feedback} role="status">
          {message}
        </p>
      )}
    </section>
  );
}
