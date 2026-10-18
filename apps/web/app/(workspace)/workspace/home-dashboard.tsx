'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Screen, WelcomeCard } from '../../../components/workspace';
import { pickNextRole } from '../../../lib/role-choices';
import { shouldReviewSavedCv } from './home-dashboard-state';
import ActivationFlow, {
  activationApi,
  type CvStatus,
} from './activation-flow';
import MatchesPanel from './matches-panel';
import { ApplicationHandoffPrompt } from '../../../components/workspace/application-handoff-prompt';
import styles from './workspace-content.module.css';

type Reminder = {
  id: string;
  opportunityId: string;
  title: string;
  dueAt: string;
};
type ApiBody<T> = { data?: T; error?: { message?: string } };
type NextAction = {
  title: string;
  description: string;
  label: string;
  opportunityId?: string;
  profile?: boolean;
  addRole?: boolean;
  matches?: boolean;
};
type WorkspaceRole = {
  job: { title: string; company: string };
  opportunity: { id: string; status: string; nextStep: string | null };
};
type ReminderResult = { reminders: Reminder[] };
type RoleResult = { opportunities?: WorkspaceRole[] } | WorkspaceRole[];

function dueLabel(value: string) {
  return new Date(value).toLocaleDateString('en-GB', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function UpcomingReminders() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadReminders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/v1/reminders', { cache: 'no-store' });
      const body = (await response.json()) as ApiBody<{
        reminders: Reminder[];
      }>;
      if (!response.ok)
        throw new Error(
          body.error?.message ?? 'Follow-ups could not be loaded.',
        );
      if (!Array.isArray(body.data?.reminders))
        throw new Error('Follow-ups could not be loaded.');
      setReminders(body.data.reminders);
      setLoaded(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Follow-ups could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReminders();
  }, [loadReminders]);

  return (
    <section className={styles.reminders} aria-labelledby="reminders-title">
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="reminders-title">Follow-ups</h2>
          <p>Things you have planned for your saved roles.</p>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          <p>{error}</p>
          <Button
            variant="text"
            disabled={loading}
            onClick={() => void loadReminders()}
          >
            {loading ? 'Trying again…' : 'Try again'}
          </Button>
        </div>
      )}
      {loading && !loaded ? (
        <p className={styles.empty} role="status">
          Checking your follow-ups…
        </p>
      ) : loaded && reminders.length ? (
        <ul className={styles.reminderList}>
          {reminders.slice(0, 3).map((reminder) => (
            <li key={reminder.id}>
              <Link href={`/workspace/roles/${reminder.opportunityId}`}>
                <strong>{reminder.title}</strong>
                <time dateTime={reminder.dueAt}>
                  {dueLabel(reminder.dueAt)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      ) : loaded && !error ? (
        <p className={styles.empty}>
          No follow-ups due. Reminders from your outreach will appear here.
        </p>
      ) : null}
    </section>
  );
}

export default function HomeDashboard({
  onOpenRole,
  onReviewProfile,
}: {
  onReviewProfile: () => void;
  onOpenRole: (opportunityId: string) => void;
}) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [savedCv, setSavedCv] = useState<CvStatus | null>(null);
  const [reviewSavedCv, setReviewSavedCv] = useState(false);
  const [setupError, setSetupError] = useState('');
  const loadSetup = useCallback(async () => {
    setSetupError('');
    try {
      const [profile, preferences, cv] = await Promise.all([
        activationApi<{ facts: { status: string }[] }>('/api/v1/profile/facts'),
        activationApi<{ targetRoles: string[] }>('/api/v1/profile/preferences'),
        activationApi<CvStatus>('/api/v1/profile/cv'),
      ]);
      setSavedCv(cv);
      const hasApprovedFacts = profile.facts.some(
        (fact) => fact.status === 'approved',
      );
      const hasTargetRole = preferences.targetRoles.length > 0;
      setReviewSavedCv(
        shouldReviewSavedCv(cv, hasApprovedFacts, hasTargetRole),
      );
      setReady(hasApprovedFacts || hasTargetRole);
    } catch {
      setSetupError('Could not load your starting point. Please try again.');
    }
  }, []);
  useEffect(() => {
    void loadSetup();
  }, [loadSetup]);
  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [actionLoading, setActionLoading] = useState(true);
  const [actionError, setActionError] = useState('');
  const loadNextAction = useCallback(async () => {
    setActionLoading(true);
    setActionError('');
    try {
      const [reminderResponse, rolesResponse] = await Promise.all([
        fetch('/api/v1/reminders', { cache: 'no-store' }),
        fetch('/api/v1/opportunities', { cache: 'no-store' }),
      ]);
      const reminders =
        (await reminderResponse.json()) as ApiBody<ReminderResult>;
      const roleBody = (await rolesResponse.json()) as ApiBody<RoleResult>;
      if (!reminderResponse.ok)
        throw new Error(
          reminders.error?.message ?? 'Follow-ups could not be loaded.',
        );
      if (!rolesResponse.ok)
        throw new Error(
          roleBody.error?.message ?? 'Saved roles could not be loaded.',
        );
      if (!Array.isArray(reminders.data?.reminders))
        throw new Error('Follow-ups could not be loaded.');
      const roleRows = Array.isArray(roleBody.data)
        ? roleBody.data
        : roleBody.data?.opportunities;
      if (!Array.isArray(roleRows))
        throw new Error('Saved roles could not be loaded.');

      const due = reminders.data.reminders
        .filter((reminder) => new Date(reminder.dueAt).getTime() <= Date.now())
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
      if (due) {
        setNextAction({
          title: due.title,
          description: `Your follow-up for ${dueLabel(due.dueAt)} is due.`,
          label: 'Open follow-up →',
          opportunityId: due.opportunityId,
        });
        return;
      }
      const next = pickNextRole(roleRows);
      if (next) {
        setNextAction({
          title: next.opportunity.nextStep!,
          description: `Your next step for ${next.job.title} at ${next.job.company}.`,
          label: 'Open role →',
          opportunityId: next.opportunity.id,
        });
        return;
      }
      if (!roleRows.length) {
        setNextAction({
          title: 'Start with your top match',
          description:
            'Your collected matches are below. Save one that interests you, or paste a job you already found.',
          label: 'See your matches ↓',
          matches: true,
        });
        return;
      }
      setNextAction({
        title: 'Review your profile',
        description:
          'Check that your experience and preferences are up to date before you choose a role.',
        label: 'Review your profile →',
        profile: true,
      });
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : 'Your next step could not be loaded.',
      );
    } finally {
      setActionLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadNextAction();
  }, [loadNextAction]);
  if (ready === null)
    return (
      <Screen title="Find a role that fits you.">
        <p role={setupError ? 'alert' : 'status'}>
          {setupError || 'Loading your starting point…'}
        </p>
        {setupError && (
          <Button onClick={() => void loadSetup()}>Try again</Button>
        )}
      </Screen>
    );
  if (reviewSavedCv && savedCv?.file)
    return (
      <ActivationFlow
        onComplete={() => {
          setReviewSavedCv(false);
          setReady(true);
          void loadSetup();
          void loadNextAction();
        }}
      />
    );
  if (!ready)
    return (
      <ActivationFlow
        onComplete={() => {
          setReady(true);
          void loadNextAction();
        }}
      />
    );
  return (
    <Screen
      variant="home"
      title="Your next step starts here."
      description="A clear view of the roles you are considering and what comes next."
    >
      <div className={styles.feed}>
        <WelcomeCard
          eyebrow="Your next useful step"
          title={
            nextAction?.title ??
            (actionLoading
              ? 'Finding your next step…'
              : 'Your next step could not be loaded.')
          }
          description={
            nextAction?.description ??
            (actionLoading
              ? 'Checking your reminders and saved roles.'
              : 'Try again to check your follow-ups and saved roles.')
          }
          actionLabel={
            nextAction?.label ?? (actionLoading ? 'Please wait' : 'Try again →')
          }
          disabled={actionLoading}
          onContinue={() => {
            if (actionLoading) return;
            if (!nextAction) {
              void loadNextAction();
              return;
            }
            if (nextAction?.matches)
              document
                .getElementById('home-matches')
                ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            else if (nextAction?.opportunityId)
              onOpenRole(nextAction.opportunityId);
            else if (nextAction?.profile) onReviewProfile();
            else if (nextAction?.addRole)
              window.location.assign('/workspace?view=roles&add=1');
          }}
        />
        {actionError && (
          <p className={styles.error} role="alert">
            {nextAction
              ? 'Could not refresh your next step. Showing the last result.'
              : actionError}{' '}
            <Button
              variant="text"
              disabled={actionLoading}
              onClick={() => void loadNextAction()}
            >
              {actionLoading ? 'Trying again…' : 'Try again'}
            </Button>
          </p>
        )}
        <MatchesPanel />
        <details>
          <summary style={{ minHeight: 44, alignContent: 'center' }}>
            Follow-ups and application check-ins
          </summary>
          <ApplicationHandoffPrompt onAnswered={() => void loadNextAction()} />
          <UpcomingReminders />
        </details>
      </div>
    </Screen>
  );
}
