'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  ProfileFact,
  ProfilePreferences,
} from '@career-workspace/contracts';
import { Button, Screen } from '../../../components/workspace';
import styles from './activation.module.css';

type Task = {
  id: string;
  status: string;
  error?: string | null;
  input?: { fileId?: string } | null;
  output?: {
    newFactCount?: number;
    duplicateFactCount?: number;
    factIds?: string[];
  } | null;
};
export type CvState = 'reading' | 'ready' | 'confirmed' | 'failed' | 'empty';
export type SavedCv = { id: string; originalName: string };
export type CvStatus = {
  file: SavedCv | null;
  task: Task | null;
  facts: ProfileFact[];
  state: CvState;
  factCount: number;
  approvedCount: number;
};
export function restoredCvStep(status: CvStatus, cvOnly = false) {
  if (
    status.state === 'ready' ||
    (Boolean(status.file) && status.state === 'empty') ||
    (cvOnly && Boolean(status.file) && status.state === 'confirmed')
  )
    return 'facts' as const;
  if (status.state === 'reading' || status.state === 'failed')
    return 'cv' as const;
  return null;
}
export function extractionNotice(
  task: Task | null,
  duplicateUpload = false,
) {
  if (duplicateUpload || task?.status !== 'succeeded') return null;
  const newFactCount = task.output?.newFactCount;
  const duplicateFactCount = task.output?.duplicateFactCount;
  if (!Number.isInteger(newFactCount) || !Number.isInteger(duplicateFactCount))
    return null;
  if (newFactCount! > 0)
    return `We found ${newFactCount} new ${newFactCount === 1 ? 'fact' : 'facts'} in your updated CV.`;
  return 'Nothing new in this CV.';
}
export function cvFactsForReview(
  facts: ProfileFact[],
  task: Task | null,
  options: { freshExtraction?: boolean; cvOnly?: boolean; confirmed?: boolean } = {},
) {
  if (
    options.freshExtraction &&
    (task?.output?.newFactCount ?? 0) > 0 &&
    Array.isArray(task?.output?.factIds)
  ) {
    const newFactIds = new Set(task.output.factIds);
    return facts.filter(
      (fact) =>
        newFactIds.has(fact.id) &&
        fact.source === 'cv' &&
        fact.status === 'proposed',
    );
  }
  const pending = facts.filter(
    (fact) => fact.source === 'cv' && fact.status === 'proposed',
  );
  if (pending.length) return pending;
  if (options.cvOnly && options.confirmed)
    return facts.filter(
      (fact) => fact.source === 'cv' && fact.status === 'approved',
    );
  return [];
}
export function cvStatusUrl(fileId?: string) {
  return fileId
    ? `/api/v1/profile/cv?${new URLSearchParams({ fileId }).toString()}`
    : '/api/v1/profile/cv';
}
export async function activationApi<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json();
  if (!response.ok || !body.data)
    throw new Error(
      body.error?.message ?? 'That did not work. Please try again.',
    );
  return body.data as T;
}
// A quote is retained by extraction only when it occurs in the uploaded CV.
// Selection is only a suggestion: approval happens after the user's click.
export function suggestedFact(fact: ProfileFact) {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const wording = normalize(fact.text);
  return (
    fact.status === 'proposed' &&
    fact.source === 'cv' &&
    wording.length > 2 &&
    normalize(fact.sourceQuote ?? '').includes(wording)
  );
}
function initialSelection(facts: ProfileFact[]) {
  return new Set(
    facts
      .filter(
        (fact) =>
          fact.status === 'approved' ||
          (fact.status === 'proposed' && fact.source === 'cv'),
      )
      .map((fact) => fact.id),
  );
}
function failureMessage(error?: string | null) {
  return error === 'AI_NOT_CONFIGURED'
    ? 'Your CV is saved but we could not read it because CV reading is not connected yet.'
    : 'Your CV is saved but we could not read it.';
}
export default function ActivationFlow({
  onComplete,
  cvOnly = false,
  returnRole,
}: {
  onComplete: () => void;
  cvOnly?: boolean;
  returnRole?: string;
}) {
  const [step, setStep] = useState<'choose' | 'role' | 'cv' | 'facts'>(
    cvOnly ? 'cv' : 'choose',
  );
  const [target, setTarget] = useState('');
  const [facts, setFacts] = useState<ProfileFact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [task, setTask] = useState<Task | null>(null);
  const [savedFile, setSavedFile] = useState<SavedCv | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [freshExtraction, setFreshExtraction] = useState(false);
  const [restored, setRestored] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const startedAt = useRef(0);
  const pausePolling = useRef(false);
  const freshExtractionTaskId = useRef<string | null>(null);

  const showFacts = useCallback((allFacts: ProfileFact[]) => {
    const candidates = allFacts.filter((fact) => fact.status !== 'rejected');
    setFacts(candidates);
    setSelected(initialSelection(candidates));
    setEdits(Object.fromEntries(candidates.map((f) => [f.id, f.text])));
    setStep('facts');
  }, []);
  const applyCvStatus = useCallback(
    (status: CvStatus, freshExtraction = false) => {
      setSavedFile(status.file);
      setTask(status.task);
      setFreshExtraction(freshExtraction);
      const restoredStep = restoredCvStep(status, cvOnly);
      if (restoredStep === 'facts') {
        showFacts(
          cvFactsForReview(status.facts, status.task, {
            freshExtraction,
            cvOnly,
            confirmed: status.state === 'confirmed',
          }),
        );
        setError('');
      } else if (restoredStep === 'cv' && status.state === 'failed') {
        setStep('cv');
        setError(failureMessage(status.task?.error));
      } else if (restoredStep === 'cv') {
        setStep('cv');
        setError('');
        startedAt.current = Date.now();
      }
    },
    [cvOnly, showFacts],
  );
  const loadCvStatus = useCallback(
    async (fileId?: string, freshTaskId?: string | null): Promise<CvStatus> => {
      const status = await activationApi<CvStatus>(cvStatusUrl(fileId));
      const isFreshExtraction = Boolean(
        freshTaskId && status.task?.id === freshTaskId,
      );
      applyCvStatus(status, isFreshExtraction);
      return status;
    },
    [applyCvStatus],
  );
  useEffect(() => {
    let cancelled = false;
    void activationApi<CvStatus>('/api/v1/profile/cv')
      .then((status) => {
        if (cancelled) return;
        applyCvStatus(status);
        setRestoreFailed(false);
        setRestored(true);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Could not check your saved CV. Please try again.');
        setRestoreFailed(true);
        setRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applyCvStatus]);
  useEffect(() => {
    if (
      pausePolling.current ||
      !task ||
      !['queued', 'running'].includes(task.status)
    )
      return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        if (Date.now() - startedAt.current > 120_000)
          throw new Error(
            'Your CV is taking longer than usual. Check again, or choose a target role while it finishes.',
          );
        const next = await activationApi<Task>(`/api/v1/tasks/${task.id}`);
        if (cancelled || pausePolling.current) return;
        setTask(next);
        if (next.status === 'succeeded') {
          const status = await activationApi<CvStatus>(
            cvStatusUrl(task.input?.fileId ?? savedFile?.id),
          );
          if (cancelled || pausePolling.current) return;
          const isFreshExtraction = task.id === freshExtractionTaskId.current;
          applyCvStatus(status, isFreshExtraction);
          if (isFreshExtraction) freshExtractionTaskId.current = null;
        }
        if (next.status === 'failed') setError(failureMessage(next.error));
      } catch (cause) {
        if (!cancelled && !pausePolling.current)
          setError(
            cause instanceof Error ? cause.message : 'Could not check your CV.',
          );
      }
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [task, savedFile, applyCvStatus]);

  async function retrySavedCv() {
    if (!savedFile) return;
    setBusy(true);
    setError('');
    setStep('cv');
    try {
      const result = await activationApi<{ file: SavedCv; task: Task }>(
        `/api/v1/profile/cv/${savedFile.id}/retry`,
        { method: 'POST' },
      );
      setSavedFile(result.file);
      setDuplicate(false);
      setTask(result.task);
      freshExtractionTaskId.current = result.task.id;
      startedAt.current = Date.now();
      if (result.task.status === 'succeeded')
        await loadCvStatus(result.file.id, result.task.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not read your CV again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setError('');
    setRestoreFailed(false);
    pausePolling.current = false;
    setStep('cv');
    setTask(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await activationApi<{
        file: SavedCv;
        task: Task;
        duplicate: boolean;
      }>('/api/v1/profile/cv', {
        method: 'POST',
        body,
      });
      setSavedFile(result.file);
      setDuplicate(result.duplicate);
      freshExtractionTaskId.current = result.duplicate ? null : result.task.id;
      startedAt.current = Date.now();
      setTask(result.task);
      await loadCvStatus(
        result.file.id,
        result.duplicate ? null : result.task.id,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not upload your CV.',
      );
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function chooseRole() {
    setBusy(true);
    setError('');
    pausePolling.current = true;
    try {
      const preferences = await activationApi<ProfilePreferences>(
        '/api/v1/profile/preferences',
      );
      await activationApi('/api/v1/profile/preferences', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...preferences, targetRoles: [target.trim()] }),
      });
      onComplete();
    } catch (cause) {
      pausePolling.current = false;
      if (task && ['queued', 'running'].includes(task.status))
        setTask({ ...task });
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save your target role.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function confirmFacts() {
    setBusy(true);
    setError('');
    try {
      for (const fact of facts.filter((f) => selected.has(f.id))) {
        await activationApi(`/api/v1/profile/facts/${fact.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: edits[fact.id], status: 'approved' }),
        });
      }
      onComplete();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm your facts. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  const pending = task && ['queued', 'running'].includes(task.status) && !error;
  const savedNotice = savedFile && (
    <p role="status">
      {duplicate ? 'You already uploaded this CV. ' : 'Saved: '}
      <strong>{savedFile.originalName}</strong>{' '}
      <Link href="/workspace?view=documents">Documents</Link>
    </p>
  );
  const newFactsNotice =
    step === 'facts' && freshExtraction
      ? extractionNotice(task, duplicate)
      : null;
  return (
    <Screen
      title={
        step === 'facts'
          ? 'Does this sound like you?'
          : 'Find a role that fits you.'
      }
      description="Start with your CV or a role you want. No credits needed to see collected matches."
    >
      <section className={styles.focus} aria-label="Get started">
        {!restored && <p role="status">Checking your saved CV…</p>}
        {savedNotice}
        <input
          ref={fileInput}
          className={styles.file}
          id="activation-cv"
          aria-label="Choose your CV"
          type="file"
          accept=".pdf,.docx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        {(step === 'choose' || step === 'cv') && (
          <>
            <h2>
              {savedFile
                ? 'Your CV is saved'
                : cvOnly
                  ? 'Add your CV for a personal fit review'
                  : 'Your next role starts with you'}
            </h2>
            {error ? (
              <p role="alert">{error}</p>
            ) : (
              <p>
                A PDF or DOCX helps us match your experience. You will confirm
                the facts before we use them.
              </p>
            )}
            {savedFile &&
              !['queued', 'running'].includes(task?.status ?? '') && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void retrySavedCv()}
                >
                  {busy ? 'Starting again…' : 'Read it again'}
                </Button>
              )}
            {!restoreFailed && (
              <Button
                variant="primary"
                disabled={!restored || busy || Boolean(pending)}
                onClick={() => fileInput.current?.click()}
              >
                {busy
                  ? 'Uploading…'
                  : pending
                    ? 'Reading your CV…'
                    : savedFile
                      ? 'Choose another CV'
                      : 'Add your CV'}
              </Button>
            )}
            {restoreFailed && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await loadCvStatus();
                    setRestoreFailed(false);
                  } catch {
                    setError(
                      'Could not check your saved CV. Please try again.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Checking…' : 'Check saved CV again'}
              </Button>
            )}
            {pending && (
              <p role="status">
                Your CV is saved. Reading your experience. Stay here; your facts
                will appear for you to confirm.
              </p>
            )}
            {error && task && ['queued', 'running'].includes(task.status) && (
              <Button
                variant="text"
                onClick={() => {
                  setError('');
                  startedAt.current = Date.now();
                  setTask({ ...task, status: 'queued' });
                }}
              >
                Check CV progress again
              </Button>
            )}
            <Button
              variant="text"
              disabled={busy}
              onClick={() => {
                pausePolling.current = true;
                setStep('role');
                setError('');
              }}
            >
              {task?.status === 'failed' && savedFile
                ? 'Choose a role instead'
                : 'Choose a role you want'}
            </Button>
          </>
        )}
        {step === 'role' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void chooseRole();
            }}
          >
            <h2>What role would you like?</h2>
            <label htmlFor="target-role">Target role</label>
            <input
              id="target-role"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              list="target-role-options"
              placeholder="For example, DevOps engineer"
              maxLength={200}
              required
            />
            <datalist id="target-role-options">
              <option>DevOps engineer</option>
              <option>Software engineer</option>
              <option>Data analyst</option>
              <option>Product designer</option>
            </datalist>
            <p>
              We will match open listings to this role. A CV is only needed when
              you want a personal fit review or to prepare an application.
            </p>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !target.trim()}
            >
              {busy ? 'Finding matches…' : 'Show my matches'}
            </Button>
            <Button
              variant="text"
              type="button"
              onClick={() => {
                pausePolling.current = false;
                setTask(task ? { ...task } : task);
                setStep('cv');
              }}
            >
              Use my CV instead
            </Button>
          </form>
        )}
        {step === 'facts' && (
          <>
            {newFactsNotice && <p role="status">{newFactsNotice}</p>}
            <p>
              <strong>Your CV is saved. Confirm the facts we found.</strong>
            </p>
            <p>
              We selected the proposed facts from your CV. They are suggestions,
              not approved facts yet.
            </p>
            {facts.length > 0 ? (
              <>
                <ul className={styles.summary}>
                  {facts
                    .filter((f) => selected.has(f.id))
                    .map((f) => (
                      <li key={f.id}>{edits[f.id]}</li>
                    ))}
                </ul>
                <details className={styles.details}>
                  <summary>Review details ({facts.length} facts)</summary>
                  {facts.map((f) => (
                    <div className={styles.fact} key={f.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.has(f.id)}
                          onChange={(e) =>
                            setSelected((previous) => {
                              const next = new Set(previous);
                              if (e.target.checked) next.add(f.id);
                              else next.delete(f.id);
                              return next;
                            })
                          }
                        />
                        Include this {f.kind}
                      </label>
                      <textarea
                        aria-label={`Edit ${f.kind} fact`}
                        value={edits[f.id]}
                        onChange={(e) =>
                          setEdits({ ...edits, [f.id]: e.target.value })
                        }
                        maxLength={10000}
                      />
                      {f.sourceQuote ? (
                        <blockquote>
                          {suggestedFact(f) && (
                            <strong>Found in your CV: </strong>
                          )}
                          {f.sourceQuote}
                        </blockquote>
                      ) : (
                        <p>
                          No verified CV quote. Check this carefully before
                          selecting it.
                        </p>
                      )}
                    </div>
                  ))}
                </details>
                <p>
                  By choosing “Looks right, continue”, you confirm the{' '}
                  {selected.size} selected{' '}
                  {selected.size === 1 ? 'fact is' : 'facts are'} accurate and
                  approve their use in your reviews and CV drafts.
                </p>
                {selected.size === 0 && (
                  <p>Pick at least one fact, or add one in Profile.</p>
                )}
                <Button
                  variant="primary"
                  disabled={
                    busy ||
                    selected.size === 0 ||
                    [...selected].some((id) => !edits[id]?.trim())
                  }
                  onClick={() => void confirmFacts()}
                >
                  {busy ? 'Confirming…' : 'Looks right, continue'}
                </Button>
              </>
            ) : (
              <>
                <p>
                  No usable facts were found. Choose a target role to see
                  listings, or add facts by hand in Profile.
                </p>
                {savedFile && (
                  <Button
                    variant="text"
                    disabled={busy}
                    onClick={() => void retrySavedCv()}
                  >
                    {busy ? 'Starting again…' : 'Read it again'}
                  </Button>
                )}
              </>
            )}
            <Button variant="text" onClick={() => setStep('role')}>
              Choose a target role instead
            </Button>
            <Link href="/workspace/profile">Add or edit facts in Profile</Link>
          </>
        )}
        {error && step !== 'cv' && (
          <div role="alert">
            <p>{error}</p>
            {task && (
              <Button
                variant="text"
                onClick={() => {
                  setError('');
                  startedAt.current = Date.now();
                  setTask({ ...task, status: 'queued' });
                }}
              >
                Check CV progress again
              </Button>
            )}
            {task?.status === 'failed' && savedFile ? (
              <>
                <Button
                  variant="text"
                  disabled={busy}
                  onClick={() => void retrySavedCv()}
                >
                  Read it again
                </Button>
                <Button variant="text" onClick={() => setStep('role')}>
                  Choose a role instead
                </Button>
              </>
            ) : (
              <Link href="/workspace/profile">Review your profile</Link>
            )}
          </div>
        )}
        {step !== 'facts' && (
          <Link
            href={
              returnRole
                ? `/workspace/roles/${returnRole}`
                : '/workspace?view=roles&add=1'
            }
          >
            {returnRole
              ? 'Back to this role'
              : 'Have a job already? Paste it here'}
          </Link>
        )}
      </section>
    </Screen>
  );
}
