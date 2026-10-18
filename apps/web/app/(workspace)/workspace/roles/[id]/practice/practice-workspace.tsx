'use client';
import CreditRecovery from '../../../../../../components/workspace/credit-recovery';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  AppShell,
  Button,
  Screen,
} from '../../../../../../components/workspace';
import ProfileActions from '../../../profile/profile-actions';
import styles from './practice-workspace.module.css';

type Api<T> = { data?: T; error?: { code?: string; message?: string } };
type Question = { question: string; focus: string };
type Feedback = {
  overall: string;
  strengths: string[];
  improvements: string[];
  nextSteps: string[];
};
type Practice = {
  id: string;
  questions: Question[];
  answers: string[];
  feedback: Feedback | null;
  status: 'questions_ready' | 'generating_feedback' | 'completed';
  createdAt: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await response.json()) as Api<T>;
  if (!response.ok) {
    if (body.error?.code === 'AI_NOT_CONFIGURED')
      throw new Error(
        'Interview practice is not configured yet. Your credits were not charged. You can return later and try again.',
      );
    if (body.error?.code === 'INSUFFICIENT_CREDITS')
      throw new Error(
        'You need 3 available credits to start an interview practice session.',
      );
    throw new Error(
      body.error?.message ??
        'We could not complete that step. Please try again.',
    );
  }
  if (body.data === undefined)
    throw new Error('The server returned an incomplete response.');
  return body.data;
}

function requestKey() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export default function PracticeWorkspace({
  opportunityId,
  roleTitle,
  company,
}: {
  opportunityId: string;
  roleTitle: string;
  company: string;
}) {
  const router = useRouter();
  const [practice, setPractice] = useState<Practice | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const sessions = await api<Practice[]>(
        `/api/v1/practice?opportunityId=${encodeURIComponent(opportunityId)}`,
      );
      const latest = sessions[0] ?? null;
      setPractice(latest);
      setDataLoaded(true);
      setError(null);
      setAnswers(
        latest
          ? latest.answers.length === latest.questions.length
            ? latest.answers
            : latest.questions.map(() => '')
          : [],
      );
      setConfirmed(false);
    } catch {
      setError('Saved practice for this role could not be loaded. Try again.');
    } finally {
      setLoading(false);
    }
  }, [opportunityId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function retryLoad() {
    setError(null);
    if (!dataLoaded) setLoading(true);
    await refresh();
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api<Practice>('/api/v1/practice', {
        method: 'POST',
        headers: { 'Idempotency-Key': requestKey() },
        body: JSON.stringify({ opportunityId }),
      });
      setPractice(created);
      setAnswers(created.questions.map(() => ''));
      setConfirmed(false);
      setNotice(
        'Your practice questions are ready. Answer from your own experience before asking for feedback.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not start interview practice.',
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!practice || !confirmed || answers.some((answer) => !answer.trim()))
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const completed = await api<Practice>(
        `/api/v1/practice/${practice.id}/answers`,
        {
          method: 'POST',
          body: JSON.stringify({ answers, confirmed: true }),
        },
      );
      setPractice(completed);
      setAnswers(completed.answers);
      setNotice(
        'Your feedback is ready. Use it as guidance, not as a hiring prediction.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not prepare your feedback.',
      );
    } finally {
      setBusy(false);
    }
  };

  const editAnswer = (index: number, value: string) => {
    setAnswers((current) =>
      current.map((answer, position) => (position === index ? value : answer)),
    );
  };
  const allAnswered =
    answers.length === practice?.questions.length &&
    answers.every((answer) => answer.trim());

  return (
    <AppShell
      active="roles"
      onNavigate={(view) =>
        router.push(view === 'home' ? '/workspace' : '/workspace')
      }
      profile={<ProfileActions />}
    >
      <Screen
        title="Practice your interview"
        description={`${roleTitle} at ${company} · Questions use the role and your approved profile facts.`}
      >
        <section className={styles.panel} aria-labelledby="practice-heading">
          <header className={styles.intro}>
            <div>
              <p className={styles.eyebrow}>Interview practice</p>
              <h2 id="practice-heading">
                Build confidence with a practice round
              </h2>
              <p>
                One session costs 3 credits. Feedback is included. Your answers
                stay private to your account.
              </p>
            </div>
            {practice && (
              <Button variant="text" onClick={start} disabled={busy}>
                Start another
              </Button>
            )}
          </header>

          {error && dataLoaded && (
            <>
              <CreditRecovery message={error} />
              <p className={styles.error} role="alert">
                {error}
              </p>
            </>
          )}
          {notice && (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          )}
          {loading && !dataLoaded ? (
            <p className={styles.muted} role="status">
              Loading your saved practice…
            </p>
          ) : !dataLoaded ? (
            <div className={styles.error}>
              <p role="alert">
                {error ||
                  'Saved practice for this role could not be loaded. Try again.'}
              </p>
              <Button variant="secondary" onClick={() => void retryLoad()}>
                Try again
              </Button>
            </div>
          ) : !practice ? (
            <div className={styles.empty}>
              <p>
                Get role-specific questions, write your own answers, then review
                coaching feedback.
              </p>
              <Button variant="primary" onClick={start} disabled={busy}>
                {busy ? 'Preparing questions…' : 'Start practice · 3 credits'}
              </Button>
            </div>
          ) : practice.status === 'completed' && practice.feedback ? (
            <div className={styles.feedback}>
              <p className={styles.complete}>Practice feedback</p>
              <h3>Overall</h3>
              <p>{practice.feedback.overall}</p>
              <div className={styles.columns}>
                <section>
                  <h3>What worked</h3>
                  <ul>
                    {practice.feedback.strengths.map((item, i) => (
                      <li key={`${i}-${item}`}>{item}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>Try next</h3>
                  <ul>
                    {practice.feedback.improvements.map((item, i) => (
                      <li key={`${i}-${item}`}>{item}</li>
                    ))}
                  </ul>
                </section>
              </div>
              <h3>Next steps</h3>
              <ul>
                {practice.feedback.nextSteps.map((item, i) => (
                  <li key={`${i}-${item}`}>{item}</li>
                ))}
              </ul>
              <p className={styles.disclaimer}>
                This feedback is a practice aid, not a hiring prediction.
              </p>
            </div>
          ) : practice.status === 'generating_feedback' ? (
            <p className={styles.muted} role="status">
              Your feedback is being prepared. Return shortly to check again.
            </p>
          ) : (
            <form className={styles.form} onSubmit={submit}>
              <ol className={styles.questions}>
                {practice.questions.map((item, index) => (
                  <li key={`${index}-${item.question}`}>
                    <label htmlFor={`answer-${index}`}>
                      <strong>{item.question}</strong>
                      <small>Focus: {item.focus}</small>
                    </label>
                    <textarea
                      id={`answer-${index}`}
                      value={answers[index] ?? ''}
                      onChange={(event) =>
                        editAnswer(index, event.target.value)
                      }
                      maxLength={8000}
                      rows={5}
                      required
                    />
                  </li>
                ))}
              </ol>
              <label className={styles.confirm}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I wrote these answers from my own experience and am ready to
                receive feedback.
              </label>
              <Button
                variant="primary"
                type="submit"
                disabled={busy || !allAnswered || !confirmed}
              >
                {busy ? 'Preparing feedback…' : 'Get feedback'}
              </Button>
              <p className={styles.muted}>
                Feedback is included in the 3-credit session. No extra credits
                are used to submit answers.
              </p>
            </form>
          )}
        </section>
      </Screen>
    </AppShell>
  );
}
