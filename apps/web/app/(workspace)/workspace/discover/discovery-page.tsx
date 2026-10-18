'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DISCOVERY_MIN_ACTIVE_JOBS,
  type DiscoveryFeed,
  type DiscoveryMatch,
} from '@career-workspace/contracts';
import {
  AppShell,
  Button,
  FitBandBadge,
  Screen,
} from '../../../../components/workspace';
import ProfileActions from '../profile/profile-actions';
import styles from './discovery.module.css';

type ApiBody<T> = {
  data?: T;
  error?: { code?: string; message?: string };
};
type SaveResult = {
  opportunity: { id: string };
  job: unknown;
};
type DiscoveryTask = { id: string; status: string; error?: string | null; output?: { refreshed?: number; failed?: number } | null };
type DiscoverySourcePage = {
  sources: DiscoveryFeed['sources'];
  sourceTotal: number;
  collection: DiscoveryFeed['collection'];
  nextOffset: number | null;
};

function completionNote(task: DiscoveryTask) {
  if (task.output?.refreshed === 0 && task.output?.failed === 0)
    return 'The job boards were checked recently or are already being collected. Check again shortly for results.';
  if (task.output?.failed)
    return `Collection finished. ${task.output.failed} sources could not update; recent saved listings are still shown.`;
  return 'Collection finished. Check your matches.';
}
type RefreshResult = {
  started: boolean;
  task: DiscoveryTask;
  workflowRunId?: string | null;
};

type CollectionState = 'idle' | 'running' | 'slow' | 'finished' | 'failed';

function automaticRefreshKeys(userId: string) {
  const scope = `discovery:auto-refresh:${userId}`;
  const requestKeyName = `${scope}:request-key`;
  let requestKey = window.sessionStorage.getItem(requestKeyName);
  if (!requestKey) {
    requestKey = crypto.randomUUID();
    window.sessionStorage.setItem(requestKeyName, requestKey);
  }
  return { scope, requestKey };
}

function apiMessage(body: ApiBody<unknown>, fallback: string) {
  return body.error?.message || fallback;
}

async function readFeed() {
  const response = await fetch('/api/v1/discovery', { cache: 'no-store' });
  const body = (await response.json()) as ApiBody<DiscoveryFeed>;
  if (!response.ok || !body.data)
    throw new Error(apiMessage(body, 'Job matches could not be loaded.'));
  return body.data;
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateLabel(value: string | null | undefined) {
  const date = parseDate(value);
  if (!date) return 'Not available';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function postedLabel(match: DiscoveryMatch) {
  const posted = parseDate(match.job.postedAt);
  if (posted) return `Posted ${dateLabel(match.job.postedAt)}`;
  return `First listed ${dateLabel(match.job.firstSeenAt)}`;
}

function workModeLabel(mode: DiscoveryMatch['job']['workMode']) {
  if (mode === 'onsite') return 'On-site';
  if (mode === 'unknown') return 'Work arrangement not listed';
  return `${mode[0].toUpperCase()}${mode.slice(1)}`;
}

function safeEmployerUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function sourceLabel(source: DiscoveryFeed['sources'][number]) {
  if (source.deadUntilAt && (parseDate(source.deadUntilAt)?.getTime() ?? 0) > Date.now()) return 'Board marked inactive';
  if (source.error === 'SOURCE_REFUSED') return 'Temporarily refused';
  const status = source.status;
  if (status === 'running') return 'Updating';
  if (status === 'succeeded') return 'Checked';
  if (status === 'failed') return 'Could not update';
  return 'Not checked yet';
}

function broaderRoleSuggestions(targetRoles: string[]) {
  const targets = targetRoles.join(' ').toLowerCase();
  if (/devops|platform|cloud|infrastructure|site reliability/.test(targets))
    return ['Software engineer', 'Platform engineer', 'Cloud engineer'];
  if (/marketing|content|communications|social media/.test(targets))
    return [
      'Marketing associate',
      'Marketing coordinator',
      'Content assistant',
    ];
  if (/finance|accounting|investment|banking/.test(targets))
    return ['Finance associate', 'Financial analyst', 'Operations associate'];
  if (/data|analytics|business intelligence/.test(targets))
    return ['Data analyst', 'Business analyst', 'Reporting analyst'];
  if (/design|ux|ui|user experience/.test(targets))
    return ['Product designer', 'UX designer', 'Visual designer'];
  if (/product|project/.test(targets))
    return ['Product associate', 'Product analyst', 'Project coordinator'];
  if (/software|engineer|developer|programming/.test(targets))
    return ['Software engineer', 'Developer', 'QA engineer'];
  return ['Software engineer', 'Analyst', 'Operations associate'];
}

export default function DiscoveryPage() {
  const { userId } = useAuth();
  const router = useRouter();
  const [feed, setFeed] = useState<DiscoveryFeed | null>(null);
  const [sourceNextOffset, setSourceNextOffset] = useState<number | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshNote, setRefreshNote] = useState('');
  const [collectionState, setCollectionState] =
    useState<CollectionState>('idle');
  const [automaticAttempted, setAutomaticAttempted] = useState(false);
  const automaticAttemptedUsers = useRef(new Set<string>());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const nextFeed = await readFeed();
      setFeed(nextFeed);
      const total = nextFeed.sourceTotal ?? nextFeed.sources.length;
      setSourceNextOffset(nextFeed.sources.length < total ? nextFeed.sources.length : null);
      return nextFeed;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Job matches could not be loaded.',
      );
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMoreSources = useCallback(async () => {
    if (sourceNextOffset === null || sourcesLoading) return;
    setSourcesLoading(true);
    setSourcesError('');
    try {
      const response = await fetch(`/api/v1/discovery/sources?offset=${sourceNextOffset}`, { cache: 'no-store' });
      const body = (await response.json()) as ApiBody<DiscoverySourcePage>;
      if (!response.ok || !body.data) throw new Error(apiMessage(body, 'More board checks could not be loaded.'));
      setFeed(current => {
        if (!current) return current;
        const seen = new Set(current.sources.map(source => source.id));
        return { ...current, sources: [...current.sources, ...body.data!.sources.filter(source => !seen.has(source.id))] };
      });
      setSourceNextOffset(body.data.nextOffset);
    } catch (cause) {
      setSourcesError(cause instanceof Error ? cause.message : 'More board checks could not be loaded.');
    } finally {
      setSourcesLoading(false);
    }
  }, [sourceNextOffset, sourcesLoading]);

  useEffect(() => {
    void load();
  }, [load]);

  const latestCheck = useMemo(() => {
    if (!feed) return 'Not checked yet';
    return dateLabel(feed.updatedAt);
  }, [feed]);

  const refresh = useCallback(async (requestKey?: string, automatic = false) => {
    if (!feed || refreshing) return;
    setRefreshing(true);
    if (automatic) setCollectionState('running');
    setError('');
    setRefreshNote('');
    setSaveError(null);
    try {
      const response = await fetch('/api/v1/discovery/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': requestKey ?? crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      });
      const body = (await response.json()) as ApiBody<RefreshResult>;
      if (!response.ok)
        throw new Error(
          apiMessage(body, 'The job boards could not be refreshed.'),
        );
      if (!body.data?.task?.id)
        throw new Error('The refresh did not return a task. Try again.');
      if (body.data.task.status === 'succeeded') {
        const freshFeed = await readFeed();
        setFeed(freshFeed);
        setSourceNextOffset(freshFeed.sources.length < (freshFeed.sourceTotal ?? freshFeed.sources.length) ? freshFeed.sources.length : null);
        setRefreshNote(completionNote(body.data.task));
        if (automatic) setCollectionState('finished');
        return;
      }
      const canPoll =
        (response.status === 202 && body.data.started) ||
        (response.status === 200 && !body.data.started);
      if (!canPoll) throw new Error('The refresh did not start. Try again.');

      const startedAt = Date.now();
      let task = body.data.task;
      while (Date.now() - startedAt < 60_000) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const taskResponse = await fetch(
          `/api/v1/tasks/${encodeURIComponent(task.id)}`,
          { cache: 'no-store' },
        );
        const taskBody = (await taskResponse.json()) as ApiBody<DiscoveryTask>;
        if (!taskResponse.ok || !taskBody.data)
          throw new Error(
            apiMessage(taskBody, 'The refresh status could not be checked.'),
          );
        task = taskBody.data;
        if (task.status === 'succeeded') {
          const freshFeed = await readFeed();
          setFeed(freshFeed);
          setSourceNextOffset(freshFeed.sources.length < (freshFeed.sourceTotal ?? freshFeed.sources.length) ? freshFeed.sources.length : null);
          setRefreshNote(completionNote(task));
          if (automatic) setCollectionState('finished');
          return;
        }
        if (task.status === 'failed')
          throw new Error(
            'The refresh failed. Your latest results are still available.',
          );
      }
      setRefreshNote(
        'The refresh is taking longer than expected. Your latest saved results are still available; try again later.',
      );
      if (automatic) setCollectionState('slow');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The job boards could not be refreshed.',
      );
      if (automatic) setCollectionState('failed');
    } finally {
      setRefreshing(false);
    }
  }, [feed, refreshing]);

  async function saveMatch(match: DiscoveryMatch) {
    if (savingId) return;
    setSavingId(match.job.id);
    setSaveError(null);
    try {
      const response = await fetch(
        `/api/v1/discovery/${encodeURIComponent(match.job.id)}/save`,
        { method: 'POST' },
      );
      const body = (await response.json()) as ApiBody<SaveResult>;
      if (!response.ok || !body.data?.opportunity?.id)
        throw new Error(apiMessage(body, 'This role could not be saved.'));
      router.push(`/workspace/roles/${body.data.opportunity.id}`);
    } catch (cause) {
      setSaveError({
        id: match.job.id,
        message:
          cause instanceof Error
            ? cause.message
            : 'This role could not be saved.',
      });
    } finally {
      setSavingId(null);
    }
  }

  function navigate(view: string) {
    const destinations: Record<string, string> = {
      home: '/workspace',
      roles: '/workspace?view=roles',
      documents: '/workspace?view=documents',
      coach: '/workspace/coach',
    };
    router.push(destinations[view] ?? '/workspace');
  }

  const matches = feed?.matches ?? [];
  const activeJobCount = feed?.totalActiveJobs ?? 0;
  const roleSuggestions = broaderRoleSuggestions(feed?.targetRoles ?? []);
  const needsCollection = Boolean(
    feed &&
      (activeJobCount < DISCOVERY_MIN_ACTIVE_JOBS || matches.length === 0),
  );

  useEffect(() => {
    if (!feed || loading || !userId || refreshing || !needsCollection) return;
    if (automaticAttemptedUsers.current.has(userId)) {
      setAutomaticAttempted(true);
      return;
    }
    automaticAttemptedUsers.current.add(userId);
    setAutomaticAttempted(true);
    const fallbackRequestKey = crypto.randomUUID();
    try {
      const { scope, requestKey: storedRequestKey } =
        automaticRefreshKeys(userId);
      if (window.sessionStorage.getItem(`${scope}:attempted`)) {
        return;
      }
      window.sessionStorage.setItem(`${scope}:attempted`, '1');
      void refresh(storedRequestKey, true);
    } catch {
      // The per-user ref still allows one attempt when browser storage is blocked.
      void refresh(fallbackRequestKey, true);
    }
  }, [feed, loading, needsCollection, refresh, refreshing, userId]);

  return (
    <AppShell
      active="discover"
      onNavigate={navigate}
      profile={<ProfileActions />}
    >
      <Screen
        className={styles.discoveryScreen}
        title="Find jobs"
        description="A shortlist from public job boards, matched to the experience and preferences you have saved."
        tools={
          <div className={styles.toolbar}>
            <p>
              Most recent successful check <strong>{latestCheck}</strong>
            </p>
            <Button
              variant="secondary"
              disabled={loading || refreshing || !feed}
              onClick={() => void refresh()}
            >
              {refreshing ? 'Checking job boards…' : 'Refresh listings'}
            </Button>
          </div>
        }
      >
        <div className={styles.discovery}>
          {error && (
            <div className={styles.error} role="alert">
              <p>{error}</p>
              <Button
                variant="text"
                disabled={loading || refreshing}
                onClick={() => void load()}
              >
                {loading ? 'Trying again…' : 'Try again'}
              </Button>
            </div>
          )}
          {refreshNote && (
            <p className={styles.refreshNote} role="status">
              {refreshNote}
            </p>
          )}
          {needsCollection && (
            <section className={styles.collectionPanel} aria-live="polite">
              <div>
                <h2>
                  {refreshing
                    ? 'Collecting open roles, this takes about a minute'
                    : collectionState === 'slow'
                      ? 'Still collecting open roles'
                      : collectionState === 'finished'
                        ? 'Collection finished'
                        : collectionState === 'failed'
                          ? 'No new roles yet'
                          : 'Looking for more open roles'}
                </h2>
                <p>
                  {refreshing
                    ? 'You can check your saved results while we collect more listings.'
                    : collectionState === 'slow'
                      ? 'The collection is taking longer than expected. Check again later or try one of these next steps.'
                      : collectionState === 'finished'
                        ? matches.length === 0
                          ? 'There are still no matches for your current target. Try a broader role or paste a job.'
                          : `We found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}, but there are still fewer than ${DISCOVERY_MIN_ACTIVE_JOBS} open listings.`
                        : collectionState === 'failed'
                          ? 'The collection did not finish. Your saved results are still here.'
                          : 'We are checking for more public listings.'}
                </p>
                {automaticAttempted && !refreshing && matches.length === 0 && (
                  <div className={styles.collectionFallback}>
                    <p>Try a broader target role:</p>
                    <ul>
                      {roleSuggestions.map((suggestion) => (
                        <li key={suggestion}>{suggestion}</li>
                      ))}
                    </ul>
                    <p>
                      <Link href="/workspace/profile">Update your target roles</Link>
                      {' · '}
                      <Link href="/workspace?view=roles">Paste a job instead</Link>
                    </p>
                  </div>
                )}
              </div>
              <Button
                variant="secondary"
                disabled={loading}
                onClick={() => void load()}
              >
                Check again
              </Button>
            </section>
          )}
          {loading && !feed ? (
            <p className={styles.loading} role="status">
              Checking job matches…
            </p>
          ) : feed ? (
            <div className={styles.columns}>
              <section
                className={styles.results}
                aria-labelledby="matches-title"
              >
                {!feed.profileReady && feed.targetRoles.length === 0 ? (
                  <div className={styles.profilePrompt}>
                    <h2 id="matches-title">
                      Add approved experience to get matches
                    </h2>
                    <p>
                      Upload your CV and approve a few facts in your profile.
                      We’ll use those details and your preferences to make a
                      shortlist.
                    </p>
                    <Link href="/workspace/profile">Open your profile →</Link>
                  </div>
                ) : (
                  <>
                    <div className={styles.resultsHeading}>
                      <div>
                        <h2 id="matches-title">Matched jobs</h2>
                        {!feed.profileReady && feed.targetRoles.length > 0 && (
                          <p>
                            Matched to your target role. Add a CV when you want a personal fit review.
                          </p>
                        )}
                        <p>
                          {matches.length} matches from {activeJobCount} active
                          listings
                        </p>
                      </div>
                      <Link href="/workspace/profile">Edit preferences</Link>
                    </div>
                    {matches.length ? (
                      <ul className={styles.jobList}>
                        {matches.map((match) => {
                          const employerUrl = safeEmployerUrl(match.job.url);
                          const source = feed.sources.find(
                            (item) => item.id === match.job.sourceId,
                          );
                          const savedId = match.savedOpportunityId;
                          return (
                            <li key={match.job.id}>
                              <article className={styles.job}>
                                <div className={styles.jobHeader}>
                                  <div>
                                    <h3>{match.job.title}</h3>
                                    <FitBandBadge band={match.fitBand} />
                                    <p className={styles.company}>
                                      {match.job.company}
                                    </p>
                                  </div>
                                  {savedId ? (
                                    <Link
                                      className={styles.savedLink}
                                      href={`/workspace/roles/${savedId}`}
                                    >
                                      Open saved role
                                    </Link>
                                  ) : (
                                    <Button
                                      variant="primary"
                                      disabled={Boolean(savingId)}
                                      onClick={() => void saveMatch(match)}
                                    >
                                      {savingId === match.job.id
                                        ? 'Saving…'
                                        : 'Save & review fit'}
                                    </Button>
                                  )}
                                </div>
                                <p className={styles.meta}>
                                  <span>
                                    {match.job.location ||
                                      'Location not listed'}
                                  </span>
                                  <span>
                                    {workModeLabel(match.job.workMode)}
                                  </span>
                                  <span>{postedLabel(match)}</span>
                                </p>
                                <p className={styles.sourceLine}>
                                  {source
                                    ? `Source: ${source.company} · ${source.board}`
                                    : `Source: ${match.job.provider}`}
                                  {employerUrl ? (
                                    <>
                                      {' '}
                                      ·{' '}
                                      <a
                                        href={employerUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        View employer listing ↗
                                      </a>
                                    </>
                                  ) : null}
                                </p>
                                {match.reasons.length > 0 && (
                                  <div className={styles.matchReason}>
                                    <h4>Why it matched</h4>
                                    <ul>
                                      {match.reasons.map((reason, index) => (
                                        <li
                                          key={`${match.job.id}-reason-${index}`}
                                        >
                                          {reason}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {match.matchedTerms.length > 0 && (
                                  <p className={styles.terms}>
                                    <strong>Matched terms:</strong>{' '}
                                    {match.matchedTerms.join(' · ')}
                                    {match.factIds.length > 0 && (
                                      <span>
                                        {' '}
                                        · Compared with {
                                          match.factIds.length
                                        }{' '}
                                        approved{' '}
                                        {match.factIds.length === 1
                                          ? 'profile fact'
                                          : 'profile facts'}
                                      </span>
                                    )}
                                  </p>
                                )}
                                {saveError?.id === match.job.id && (
                                  <p className={styles.error} role="alert">
                                    {saveError.message}
                                  </p>
                                )}
                              </article>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className={styles.empty}>
                        <h3>No matching jobs in the current listings</h3>
                        <p>
                          Refresh the boards or adjust your target roles and
                          location in your profile.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </section>
              <aside className={styles.sources} aria-labelledby="sources-title">
                <div className={styles.sourcesHeading}>
                  <h2 id="sources-title">Job board checks</h2>
                  <p>Showing {feed.sources.length.toLocaleString()} of {(feed.sourceTotal ?? feed.sources.length).toLocaleString()} public boards.</p>
                </div>
                {feed.collection && (
                  <div className={styles.collectionSummary} aria-label="Collection health">
                    <p><strong>Board catalog:</strong> {feed.collection.catalogBoards.toLocaleString()}</p>
                    <p><strong>Verified:</strong> {feed.collection.verifiedBoards.toLocaleString()} · <strong>Marked inactive:</strong> {feed.collection.deadBoards.toLocaleString()} · <strong>Temporarily refused:</strong> {feed.collection.refusedBoards.toLocaleString()}</p>
                    <p><strong>Dataset cache refreshed:</strong> {dateLabel(feed.collection.datasetFetchedAt)} · <strong>Progress:</strong> {feed.collection.cursor.toLocaleString()}</p>
                    {feed.collection.datasetError && <p className={styles.sourceError}>{feed.collection.datasetError === 'INVALID_SLUGS_SKIPPED' ? 'Some invalid board names were skipped.' : 'The source list could not be refreshed.'}</p>}
                  </div>
                )}
                {feed.sources.length ? (
                  <ul>
                    {feed.sources.map((source) => (
                      <li key={source.id}>
                        <div className={styles.sourceTopline}>
                          <strong>{source.company}</strong>
                          <span
                            className={
                              source.status === 'failed'
                                ? styles.failed
                                : source.status === 'running'
                                  ? styles.running
                                  : styles.sourceStatus
                            }
                          >
                            {sourceLabel(source)}
                          </span>
                        </div>
                        <p>{source.board}</p>
                        <p>{source.activeJobCount} active listings</p>
                        <small>
                          Last successful check:{' '}
                          {dateLabel(source.lastSuccessAt)}
                        </small>
                        {source.verifiedAt && <small> · Last verified {dateLabel(source.verifiedAt)}</small>}
                        {source.failureCount !== undefined && source.failureCount > 0 && <small> · {source.failureCount} recent failures</small>}
                        {source.deadUntilAt && <small> · Inactive until {dateLabel(source.deadUntilAt)}</small>}
                        {source.nextRetryAt && <small> · Retry after {dateLabel(source.nextRetryAt)}</small>}
                        {source.error && (
                          <p className={styles.sourceError}>{source.error}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.empty}>
                    No board status is available yet.
                  </p>
                )}
                {sourcesError && <p className={styles.sourceError} role="alert">{sourcesError}</p>}
                {sourceNextOffset !== null && (
                  <Button type="button" variant="secondary" onClick={() => void loadMoreSources()} disabled={sourcesLoading}>
                    {sourcesLoading ? 'Loading boards…' : 'Load more board checks'}
                  </Button>
                )}
                <p className={styles.sourceNote}>
                  Matches use profile keywords. They are a shortlist, not a
                  hiring prediction. Review each listing with the employer
                  before applying.
                </p>
              </aside>
            </div>
          ) : null}
        </div>
      </Screen>
    </AppShell>
  );
}
