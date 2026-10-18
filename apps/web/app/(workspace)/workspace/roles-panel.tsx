'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { activationApi } from './activation-flow';
import CreditRecovery from '../../../components/workspace/credit-recovery';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Button,
  EvidenceTable,
  FitScorecardView,
  OpportunityTable,
  RoleWorkspace,
  Verdict,
} from '../../../components/workspace';
import type { FitScoreBand, FitScorecard } from '@career-workspace/contracts';
import {
  emptyRolesMessage,
  timelineEventLabel,
} from '../../../lib/role-choices';
import RoleContacts from './roles-panel-contacts';
import s from './roles-panel.module.css';

type Job = {
  id: string;
  title: string;
  company: string;
  url: string | null;
  text: string;
  location?: string | null;
};
type Opportunity = {
  id: string;
  status: string;
  nextStep: string | null;
  hasFitReview?: boolean;
  fitBand?: FitScoreBand | null;
};
type RoleRecord = {
  job: Job;
  opportunity: Opportunity;
  hasFitReview?: boolean;
  fitBand?: FitScoreBand | null;
};
type FitReview = {
  promptVersion: string;
  outdated?: boolean;
  verdict: string;
  strengths: { text: string; fact_ids: string[] }[];
  gaps: string[];
  unknowns: string[];
  scorecard?: FitScorecard | null;
};
type TimelineItem = {
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
};
type ApiResult<T> = { data: T; error?: { code?: string; message?: string } };
const states = [
  'saved',
  'reviewed',
  'preparing',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
];

async function readApi<T>(response: Response): Promise<ApiResult<T>> {
  return (await response.json()) as ApiResult<T>;
}

export default function RolesPanel({
  onAskCoach,
  initialOpportunityId,
  initialAddRole = false,
  autoReview = false,
  practiceEnabled = false,
  homeMode = false,
  onOpenRole,
  onBackToRoles,
}: {
  onAskCoach?: (opportunityId: string) => void;
  initialOpportunityId?: string;
  initialAddRole?: boolean;
  autoReview?: boolean;
  practiceEnabled?: boolean;
  homeMode?: boolean;
  onOpenRole?: (opportunityId: string) => void;
  onBackToRoles?: () => void;
}) {
  const router = useRouter();
  const [firstReviewFree, setFirstReviewFree] = useState(false);
  const [hasFacts, setHasFacts] = useState<boolean | null>(null);
  const [approvedFacts, setApprovedFacts] = useState<Record<string, string>>(
    {},
  );
  const loadEligibility = useCallback(async (): Promise<boolean | null> => {
    try {
      const [credits, profile] = await Promise.all([
        activationApi<{ firstReviewFree: boolean }>('/api/v1/credits'),
        activationApi<{
          facts: { id: string; text: string; status: string }[];
        }>('/api/v1/profile/facts'),
      ]);
      setFirstReviewFree(credits.firstReviewFree);
      const approved = profile.facts.filter((fact) => fact.status === 'approved');
      setHasFacts(approved.length > 0);
      setApprovedFacts(Object.fromEntries(approved.map((fact) => [fact.id, fact.text])));
      return approved.length > 0;
    } catch {
      setHasFacts(null);
      return null;
    }
  }, []);
  useEffect(() => {
    void loadEligibility();
  }, [loadEligibility]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(
    initialOpportunityId ?? null,
  );
  const [detail, setDetail] = useState<RoleRecord | null>(null);
  const [reviews, setReviews] = useState<FitReview[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [rolesReadError, setRolesReadError] = useState('');
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailReadError, setDetailReadError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const detailRequestId = useRef(0);
  const pendingReviewKeys = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(initialAddRole);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [fitFilter, setFitFilter] = useState('all');
  const [detailStage, setDetailStage] = useState<'review' | 'resume' | 'track'>(
    'review',
  );

  const loadRoles = useCallback(async () => {
    setRolesLoading(true);
    setRolesReadError('');
    try {
      const response = await fetch('/api/v1/opportunities', {
        cache: 'no-store',
      });
      const result = await readApi<
        { opportunities?: RoleRecord[] } | RoleRecord[]
      >(response);
      if (!response.ok)
        throw new Error(
          result.error?.message ?? 'Your roles could not be loaded.',
        );
      const rows = Array.isArray(result.data)
        ? result.data
        : (result.data.opportunities ?? []);
      setRoles(rows);
      setRolesLoaded(true);
      return rows;
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : 'Your roles could not be loaded.';
      setRolesReadError(message);
      throw cause instanceof Error ? cause : new Error(message);
    } finally {
      setRolesLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const requestId = ++detailRequestId.current;
    setDetailLoadingId(id);
    setDetailReadError(null);
    try {
      const [opportunityResponse, reviewResponse, timelineResponse] =
        await Promise.all([
          fetch(`/api/v1/opportunities/${id}`, { cache: 'no-store' }),
          fetch(`/api/v1/opportunities/${id}/fit-review`, {
            cache: 'no-store',
          }),
          fetch(`/api/v1/opportunities/${id}/timeline`, {
            cache: 'no-store',
          }),
        ]);
      const [opportunityResult, reviewResult, timelineResult] =
        await Promise.all([
          readApi<RoleRecord>(opportunityResponse),
          readApi<FitReview[]>(reviewResponse),
          readApi<{ timeline: TimelineItem[] }>(timelineResponse),
        ]);
      if (!opportunityResponse.ok)
        throw new Error(
          opportunityResult.error?.message ?? 'This role could not be opened.',
        );
      if (!reviewResponse.ok)
        throw new Error(
          reviewResult.error?.message ?? 'Fit review could not be loaded.',
        );
      if (!timelineResponse.ok)
        throw new Error(
          timelineResult.error?.message ?? 'Role history could not be loaded.',
        );
      if (requestId !== detailRequestId.current) return;
      setDetail(opportunityResult.data);
      setReviews(Array.isArray(reviewResult.data) ? reviewResult.data : []);
      setTimeline(timelineResult.data.timeline ?? []);
    } catch (cause) {
      if (requestId === detailRequestId.current) {
        setDetailReadError({
          id,
          message:
            cause instanceof Error
              ? cause.message
              : 'This role could not be opened.',
        });
      }
      throw cause;
    } finally {
      if (requestId === detailRequestId.current) setDetailLoadingId(null);
    }
  }, []);

  useEffect(() => {
    void loadRoles().catch(() => undefined);
  }, [loadRoles]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    setDetailStage('review');
    void loadDetail(selected).catch(() => undefined);
  }, [selected, loadDetail]);

  function retryDetail(id: string) {
    void loadDetail(id).catch(() => undefined);
  }

  const autoReviewStarted = useRef(false);
  useEffect(() => {
    if (
      !autoReview ||
      !hasFacts ||
      !firstReviewFree ||
      !selected ||
      detail?.opportunity.id !== selected ||
      reviews.length ||
      autoReviewStarted.current
    )
      return;
    autoReviewStarted.current = true;
    setBusy(true);
    setNotice(
      'Your first fit review is free. Checking this role against your confirmed facts…',
    );
    void activationApi<FitReview>(
      `/api/v1/opportunities/${selected}/fit-review`,
      {
        method: 'POST',
        headers: {
          'idempotency-key': `initial-fit:${selected}`,
          'x-review-price': 'free',
        },
      },
    )
      .then(async () => {
        await Promise.all([
          loadDetail(selected),
          loadRoles(),
          loadEligibility(),
        ]);
        setNotice('Your free fit review is ready.');
      })
      .catch((cause) => {
        void loadEligibility();
        setNotice('');
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not review this role.',
        );
      })
      .finally(() => setBusy(false));
  }, [
    autoReview,
    hasFacts,
    firstReviewFree,
    selected,
    detail,
    reviews.length,
    loadDetail,
    loadRoles,
    loadEligibility,
  ]);

  async function requestFitReview(id: string, key = `initial-fit:${id}`) {
    const response = await fetch(`/api/v1/opportunities/${id}/fit-review`, {
      method: 'POST',
      headers: {
        'idempotency-key': key,
        ...(firstReviewFree ? { 'x-review-price': 'free' } : {}),
      },
    });
    const result = await readApi<FitReview>(response);
    if (!response.ok) {
      if (result.error?.code === 'FREE_REVIEW_UNAVAILABLE')
        await loadEligibility();
      throw new Error(
        result.error?.message ?? 'Fit review could not be created.',
      );
    }
    return result.data;
  }

  async function addRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const currentHasApprovedFacts = await loadEligibility();
      if (currentHasApprovedFacts === null)
        throw new Error('Could not check your approved profile facts. Please try again.');
      const response = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: String(form.get('title') ?? '').trim(),
          company: String(form.get('company') ?? '').trim(),
          location: form.get('location') || undefined,
          url: form.get('url') || undefined,
          text: form.get('text') || undefined,
        }),
      });
      const result = await readApi<RoleRecord>(response);
      if (!response.ok)
        throw new Error(
          result.error?.message ?? 'The role could not be saved.',
        );
      const id = result.data.opportunity.id;
      setAdding(false);
      setSelected(id);
      if (!currentHasApprovedFacts) {
        await loadRoles();
        router.push(`/workspace?setup=cv&returnRole=${id}`);
        return;
      }
      setNotice('Role saved. Reviewing the requirements…');
      // A repeat save reuses the existing first review, with no second charge.
      const saved = await fetch(`/api/v1/opportunities/${id}/fit-review`, {
        cache: 'no-store',
      });
      const existing = await readApi<FitReview[]>(saved);
      if (!saved.ok)
        throw new Error(
          existing.error?.message ?? 'Saved fit review could not be loaded.',
        );
      if (!existing.data.length) await requestFitReview(id);
      await Promise.all([loadRoles(), loadDetail(id), loadEligibility()]);
      setNotice(
        'Fit review saved. Read the gaps and open questions before preparing.',
      );
    } catch (cause) {
      setNotice('');
      setError(
        cause instanceof Error
          ? cause.message
          : 'The role could not be saved. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function createFitReview() {
    if (!selected || busy) return;
    if (!hasFacts) {
      router.push(`/workspace?setup=cv&returnRole=${selected}`);
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let key = pendingReviewKeys.current.get(selected);
      if (!key) {
        key = reviews.length ? crypto.randomUUID() : `initial-fit:${selected}`;
        pendingReviewKeys.current.set(selected, key);
      }
      await requestFitReview(selected, key);
      await Promise.all([loadDetail(selected), loadRoles(), loadEligibility()]);
      pendingReviewKeys.current.delete(selected);
      setNotice('Fit review saved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Fit review could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(status: string) {
    if (!selected) return false;
    setBusy(true);
    setError('');
    setNotice('');
    const response = await fetch(`/api/v1/opportunities/${selected}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const result = await readApi<unknown>(response);
    setBusy(false);
    if (!response.ok) {
      setError(
        result.error?.message ?? 'The role status could not be updated.',
      );
      return false;
    }
    setNotice('Status updated.');
    await Promise.all([
      loadRoles().catch(() => undefined),
      loadDetail(selected).catch(() => undefined),
    ]);
    return true;
  }

  const selectedDetail =
    selected && detail?.opportunity.id === selected ? detail : null;
  if (selected && !selectedDetail) {
    const failed = detailReadError?.id === selected ? detailReadError : null;
    return (
      <section className={s.panel} aria-label="Role details">
        <Button
          variant="text"
          onClick={() => {
            setSelected(null);
            setError('');
            setNotice('');
          }}
        >
          ← All roles
        </Button>
        {failed ? (
          <div className={s.error} role="alert">
            <p>{failed.message}</p>
            <Button
              variant="text"
              disabled={detailLoadingId === selected}
              onClick={() => retryDetail(selected)}
            >
              {detailLoadingId === selected ? 'Trying again…' : 'Try again'}
            </Button>
          </div>
        ) : (
          <p role="status">Loading role details…</p>
        )}
      </section>
    );
  }

  if (selected && selectedDetail) {
    const detailError =
      detailReadError?.id === selected ? detailReadError : null;
    const { job, opportunity } = selectedDetail;
    const review = reviews[0];
    const statusLabel = (value: string) => value.replaceAll('_', ' ');
    const timelineLabel = (item: TimelineItem) => {
      const data = item.data ?? {};
      if (item.type === 'opportunity.status_changed') {
        const from =
          typeof data.from === 'string' ? statusLabel(data.from) : '';
        const to = typeof data.to === 'string' ? statusLabel(data.to) : '';
        return from && to
          ? `Status changed from ${from} to ${to}`
          : `Status set to ${to || statusLabel(opportunity.status)}`;
      }
      return timelineEventLabel(item.type);
    };
    const evidenceRows = review
      ? [
          ...review.gaps.map((gap) => ({
            area: 'To consider',
            assessment: gap,
            explanation:
              'This is a requirement or constraint to consider. It does not prove you lack the experience.',
          })),
          ...review.strengths.map((item) => ({
            area: 'You’ve shown this',
            assessment: item.text,
            explanation: `Cites ${item.fact_ids.length} approved profile ${item.fact_ids.length === 1 ? 'fact' : 'facts'}; check the wording against them.`,
          })),
          ...review.unknowns.map((item) => ({
            area: 'Still unknown',
            assessment: item,
            explanation:
              'This detail is not confirmed in your profile or the saved role.',
          })),
        ]
      : [];
    return (
      <RoleWorkspace
        role={{
          id: opportunity.id,
          title: job.title,
          company: job.company,
          location: job.location || 'Location not provided',
          score: null,
          reason: '',
          reviewed: Boolean(review),
          fitBand:
            review?.scorecard?.band ?? opportunity.fitBand ?? selectedDetail.fitBand ?? null,
        }}
        stage={detailStage}
        onStage={(stage) => {
          setDetailStage(stage);
          if (stage === 'resume')
            window.location.assign(`/workspace/roles/${opportunity.id}/resume`);
          if (stage === 'track')
            document
              .getElementById('role-progress')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          if (stage === 'review')
            document
              .getElementById('fit-title')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
        onBack={() => {
          setError('');
          setNotice('');
          if (initialOpportunityId) onBackToRoles?.();
          else setSelected(null);
        }}
        onChat={() => onAskCoach?.(opportunity.id)}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void updateStatus('saved')}
            >
              Save for later
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  if (await updateStatus('preparing'))
                    window.location.assign(
                      `/workspace/roles/${opportunity.id}/resume?prepare=1`,
                    );
                })();
              }}
            >
              Prepare this application · CV 3 credits
            </Button>
          </>
        }
      >
        <div className={s.roleDetailBody}>
          {practiceEnabled && (
            <a
              className={s.practiceLink}
              href={`/workspace/roles/${opportunity.id}/practice`}
            >
              Practice interview · 3 credits
            </a>
          )}
          <CreditRecovery message={error} />
          {detailError && (
            <div className={s.error} role="alert">
              <p>{detailError.message}</p>
              <Button
                variant="text"
                disabled={detailLoadingId === selected}
                onClick={() => retryDetail(selected)}
              >
                {detailLoadingId === selected ? 'Refreshing…' : 'Try again'}
              </Button>
            </div>
          )}
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className={s.notice} role="status">
              {notice}
            </p>
          )}
          <div className={s.detailGrid}>
            <section className={s.card} aria-labelledby="fit-title">
              <div className={s.sectionHeading}>
                <h3 id="fit-title">Fit review</h3>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void createFitReview()}
                >
                  {hasFacts === false
                    ? firstReviewFree
                      ? 'Add your CV · first review free'
                      : 'Add your CV for a fit review'
                    : firstReviewFree
                      ? 'Review fit · free first review'
                      : review?.outdated
                        ? 'Refresh review · 1 credit'
                        : 'Review fit · 1 credit'}
                </Button>
              </div>
              {review ? (
                <>
                  {review.outdated && (
                    <p className={s.notice} role="status">
                      You have approved new profile facts since this review. It
                      reflects your earlier profile; refresh it for 1 credit.
                    </p>
                  )}
                  <Verdict title={review.verdict}>
                    Check the evidence and open questions below before deciding.
                  </Verdict>
                  <FitScorecardView scorecard={review.scorecard} factTexts={approvedFacts} />
                  {review.gaps.length > 0 && (
                    <h4 className={s.srOnly}>Gaps to consider</h4>
                  )}
                  {review.strengths.length > 0 && (
                    <h4 className={s.srOnly}>Evidence from your profile</h4>
                  )}
                  {review.unknowns.length > 0 && (
                    <h4 className={s.srOnly}>Still unknown</h4>
                  )}
                  <EvidenceTable rows={evidenceRows} />
                </>
              ) : (
                <p>
                  Review the role requirements first. Your experience stays
                  unknown until you approve CV facts; no score is invented.
                </p>
              )}
            </section>
            <section
              className={s.card}
              id="role-progress"
              aria-labelledby="progress-title"
            >
              <h3 id="progress-title">Progress</h3>
              <label className={s.statusLabel} htmlFor="role-status">
                Current status
              </label>
              <select
                id="role-status"
                value={opportunity.status}
                disabled={busy}
                onChange={(event) => void updateStatus(event.target.value)}
              >
                {states.map((state) => (
                  <option key={state} value={state}>
                    {state[0].toUpperCase() + state.slice(1)}
                  </option>
                ))}
              </select>
              {opportunity.nextStep && (
                <p>
                  <strong>Next step:</strong> {opportunity.nextStep}
                </p>
              )}
              <h4>Timeline</h4>
              {timeline.length ? (
                <ol className={s.timeline}>
                  {timeline.map((item, i) => (
                    <li key={`${item.type}-${item.createdAt}-${i}`}>
                      <strong>{timelineLabel(item)}</strong>
                      <time>
                        {new Date(item.createdAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No updates yet.</p>
              )}
            </section>
          </div>
          <RoleContacts opportunityId={opportunity.id} />
        </div>
      </RoleWorkspace>
    );
  }

  return (
    <section
      className={`${s.panel} ${homeMode ? s.homePanel : ''}`}
      aria-label="My roles"
    >
      <div className={s.listHeading}>
        <div>
          {homeMode ? <h2>My roles</h2> : <h1>My roles</h1>}
          <p>
            {homeMode
              ? 'Keep the roles you are considering together.'
              : 'Save a role to compare it with the evidence in your profile.'}
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setAdding((value) => !value);
            setError('');
          }}
        >
          {adding ? 'Close form' : 'Add a role'}
        </Button>
      </div>
      <CreditRecovery message={error} />
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={s.notice} role="status">
          {notice}
        </p>
      )}
      {!rolesLoaded && rolesLoading && (
        <p role="status">Loading your saved roles…</p>
      )}
      {!rolesLoaded && !rolesLoading && (
        <div className={s.error} role="alert">
          <p>{rolesReadError || 'Your roles could not be loaded.'}</p>
          <Button
            variant="text"
            disabled={rolesLoading}
            onClick={() => void loadRoles().catch(() => undefined)}
          >
            {rolesLoading ? 'Trying again…' : 'Try again'}
          </Button>
        </div>
      )}
      {rolesLoaded && rolesReadError && (
        <div className={s.error} role="alert">
          <p>{rolesReadError}</p>
          <Button
            variant="text"
            disabled={rolesLoading}
            onClick={() => void loadRoles().catch(() => undefined)}
          >
            {rolesLoading ? 'Refreshing…' : 'Try again'}
          </Button>
        </div>
      )}
      {rolesLoaded && rolesLoading && (
        <p role="status">Refreshing your saved roles…</p>
      )}
      {rolesLoaded && (
        <>
          <div className={s.filters} aria-label="Filter roles">
            <label>
              Search roles
              <input
                type="search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Role, company or location"
              />
            </label>
            <label>
              Status
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="all">All statuses</option>
                {states.map((state) => (
                  <option key={state} value={state}>
                    {stateLabel(state)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Fit review
              <select
                value={fitFilter}
                onChange={(event) => setFitFilter(event.target.value)}
              >
                <option value="all">All roles</option>
                <option value="reviewed">Reviewed</option>
                <option value="unreviewed">Not reviewed</option>
              </select>
            </label>
          </div>
          <p>
            <Link href="/workspace">Browse open roles matched to you</Link>
          </p>
          {adding && (
            <form
              className={s.addForm}
              onSubmit={(event) => void addRole(event)}
            >
              <h3>Add a role</h3>
              <label>
                Job title
                <input name="title" maxLength={200} required />
              </label>
              <label>
                Company
                <input name="company" maxLength={200} required />
              </label>
              <label>
                Location (optional)
                <input
                  name="location"
                  maxLength={200}
                  placeholder="City, country or remote"
                />
              </label>
              <label>
                Role link (optional)
                <input
                  name="url"
                  type="url"
                  placeholder="https://example.com/jobs/…"
                />
              </label>
              <label>
                Or paste the role description
                <textarea
                  name="text"
                  rows={7}
                  minLength={120}
                  placeholder="Paste at least 120 characters of the job description."
                />
              </label>
              <p>
                Provide a link or paste the job description. We keep the saved
                text for your review. Saving is free.{' '}
                {firstReviewFree
                  ? 'Your first fit review is free.'
                  : 'A fit review costs 1 credit; failed reviews are not charged.'}{' '}
                {!hasFacts &&
                  'Add and confirm CV facts before your personal fit review.'}
              </p>
              <Button variant="primary" type="submit" disabled={busy}>
                {busy
                  ? 'Saving…'
                  : !hasFacts
                    ? 'Save role and add CV'
                    : firstReviewFree
                      ? 'Save role · first review free'
                      : 'Save role · review 1 credit'}
              </Button>
            </form>
          )}
          <OpportunityTable
            opportunities={roles
              .filter((role) => {
                const { job, opportunity } = role;
                const query = searchText.trim().toLocaleLowerCase();
                const matchesSearch =
                  !query ||
                  [job.title, job.company, job.location].some((value) =>
                    value?.toLocaleLowerCase().includes(query),
                  );
                const matchesStatus =
                  statusFilter === 'all' || opportunity.status === statusFilter;
                const matchesReview =
                  fitFilter === 'all' ||
                  Boolean(opportunity.hasFitReview ?? role.hasFitReview) ===
                    (fitFilter === 'reviewed');
                return matchesSearch && matchesStatus && matchesReview;
              })
              .map(({ job, opportunity, fitBand }) => ({
                id: opportunity.id,
                title: job.title,
                company: job.company,
                location: job.location,
                status: opportunity.status,
                nextStep: opportunity.nextStep,
                fitBand: opportunity.fitBand ?? fitBand ?? null,
              }))}
            emptyMessage={emptyRolesMessage(roles.length)}
            onOpen={(opportunity) => {
              setError('');
              if (onOpenRole) onOpenRole(opportunity.id);
              else setSelected(opportunity.id);
            }}
          />
        </>
      )}
    </section>
  );
}

function stateLabel(state: string) {
  return state[0].toUpperCase() + state.slice(1).replaceAll('_', ' ');
}
