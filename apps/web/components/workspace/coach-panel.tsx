'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { COACH_MESSAGE_MAX_CHARS } from '@career-workspace/contracts';
import { Button, ChatPanel, type ChatMessage } from './index';
import s from './coach-panel.module.css';

type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string } };
type CoachMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'completed' | 'failed';
};
type CoachAllowance = {
  limit: number;
  used: number;
  pending: number;
  remaining: number;
  resetAt: string | null;
};
type StatusProposal = {
  id: string;
  kind?: 'change_status';
  opportunityId: string;
  data: { from: string; to: string; reason: string };
  confirmedAt: string | null;
};
type SaveDiscoveredJobProposal = {
  id: string;
  kind: 'save_discovered_job';
  opportunityId: string | null;
  data: {
    discoveredJobId: string;
    title: string;
    company: string;
    url: string;
  };
  confirmedAt: string | null;
};
type CoachProposal = StatusProposal | SaveDiscoveredJobProposal;
type RoleRecord = {
  opportunity: { id: string; status: string; nextStep: string | null };
  job: { title: string; company: string };
};
type ConfirmResult = {
  proposal: CoachProposal;
  opportunity: { id: string; status: string; nextStep: string | null };
  alreadyConfirmed: boolean;
};
const EMPTY_DISCOVERY_REPLY =
  'No matches collected yet. Open Discover on the web to refresh.';

async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    return {};
  }
}

function errorMessage(code?: string, message?: string) {
  if (code === 'AI_NOT_CONFIGURED')
    return 'Your coach is not connected to AI yet. No message allowance was used.';
  if (code === 'COACH_DAILY_LIMIT')
    return message ?? 'Your rolling 24-hour coach limit has been reached.';
  if (code === 'COACH_MESSAGE_IN_PROGRESS')
    return 'This message is still being answered. Wait a moment, then try again.';
  return message ?? 'Your message could not be sent. Try again.';
}

function label(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function CoachWorkspacePanel({
  onClose,
  opportunityId,
}: {
  onClose: () => void;
  opportunityId?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<CoachProposal[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [coachAllowance, setCoachAllowance] = useState<CoachAllowance | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [aiOff, setAiOff] = useState(false);
  const [dailyLimitReached, setDailyLimitReached] = useState(false);
  const loadInFlight = useRef<Promise<void> | null>(null);

  const loadRoles = useCallback(async () => {
    const response = await fetch('/api/v1/opportunities', {
      cache: 'no-store',
    });
    const envelope = await readEnvelope<RoleRecord[]>(response);
    if (!response.ok)
      throw new Error(
        envelope.error?.message ?? 'Your role statuses could not be loaded.',
      );
    const rows = Array.isArray(envelope.data) ? envelope.data : [];
    setRoles(rows);
    return rows;
  }, []);

  const loadAllowance = useCallback(async () => {
    const response = await fetch('/api/v1/coach/allowance', { cache: 'no-store' });
    const envelope = await readEnvelope<CoachAllowance>(response);
    if (!response.ok || !envelope.data)
      throw new Error(envelope.error?.message ?? 'Your coach allowance could not be loaded.');
    setCoachAllowance(envelope.data);
    return envelope.data;
  }, []);

  const loadWorkspace = useCallback(() => {
    if (loadInFlight.current) return loadInFlight.current;
    const request = (async () => {
      setError('');
      try {
        const responses = await Promise.all([
          fetch('/api/v1/coach/messages', { cache: 'no-store' }),
          fetch('/api/v1/coach/proposals', { cache: 'no-store' }),
          fetch('/api/v1/opportunities', { cache: 'no-store' }),
          fetch('/api/v1/coach/allowance', { cache: 'no-store' }),
        ]);
        const [messagesResult, proposalsResult, rolesResult, allowanceResult] =
          await Promise.all(
            responses.map((response) => readEnvelope<unknown>(response)),
          );
        const failedIndex = responses.findIndex((response) => !response.ok);
        if (failedIndex !== -1) {
          const failure = [messagesResult, proposalsResult, rolesResult, allowanceResult][
            failedIndex
          ] as ApiEnvelope<unknown>;
          throw new Error(
            failure.error?.message ??
              'Your coach workspace could not be loaded.',
          );
        }
        setMessages(
          ((messagesResult.data as CoachMessage[] | undefined) ?? [])
            .filter(
              (row) => row.status === 'completed' || row.status === 'pending',
            )
            .map((row) => ({
              id: row.id,
              author: row.role === 'user' ? 'user' : 'oppa',
              text: row.content,
            })),
        );
        setProposals(
          (proposalsResult.data as CoachProposal[] | undefined) ?? [],
        );
        setRoles((rolesResult.data as RoleRecord[] | undefined) ?? []);
        setCoachAllowance(allowanceResult.data as CoachAllowance);
        setLoaded(true);
      } catch {
        setError('Your coach workspace could not be loaded. Try again.');
      } finally {
        setLoading(false);
        loadInFlight.current = null;
      }
    })();
    loadInFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  async function retryLoad() {
    setError('');
    if (!loaded) setLoading(true);
    await loadWorkspace();
  }

  async function sendMessage(text: string) {
    if (pending) return;
    const localId = crypto.randomUUID();
    const replyId = `${localId}-reply`;
    setPending(true);
    setError('');
    setDailyLimitReached(false);
    setMessages((current) => [
      ...current,
      { id: localId, author: 'user', text },
    ]);
    try {
      const response = await fetch('/api/v1/coach/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          message: text,
          ...(opportunityId ? { opportunityId } : {}),
        }),
      });
      if (!response.ok) {
        const result = await readEnvelope<never>(response);
        setMessages((current) => current.filter((item) => item.id !== localId));
        if (result.error?.code === 'AI_NOT_CONFIGURED') setAiOff(true);
        else {
          setDailyLimitReached(result.error?.code === 'COACH_DAILY_LIMIT');
          setError(errorMessage(result.error?.code, result.error?.message));
          if (result.error?.code === 'COACH_DAILY_LIMIT')
            void loadAllowance().catch(() => undefined);
        }
        return;
      }
      if (!response.body)
        throw new Error('Your coach reply could not be streamed. Try again.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let reply = '';
      let replyShown = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        if (!replyShown) {
          replyShown = true;
          setMessages((current) => [
            ...current,
            { id: replyId, author: 'oppa', text: reply },
          ]);
        } else {
          setMessages((current) =>
            current.map((item) =>
              item.id === replyId ? { ...item, text: reply } : item,
            ),
          );
        }
      }
      const finalChunk = decoder.decode();
      if (finalChunk) {
        reply += finalChunk;
        if (replyShown)
          setMessages((current) =>
            current.map((item) =>
              item.id === replyId ? { ...item, text: reply } : item,
            ),
          );
        else
          setMessages((current) => [
            ...current,
            { id: replyId, author: 'oppa', text: reply },
          ]);
      }
      await Promise.all([loadRoles(), loadProposals(), loadAllowance()]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The connection stopped before your coach replied.',
      );
    } finally {
      setPending(false);
    }
  }

  async function loadProposals() {
    const response = await fetch('/api/v1/coach/proposals', {
      cache: 'no-store',
    });
    const envelope = await readEnvelope<CoachProposal[]>(response);
    if (!response.ok)
      throw new Error(
        envelope.error?.message ?? 'Status suggestions could not be refreshed.',
      );
    setProposals(envelope.data ?? []);
  }

  async function confirmProposal(proposalId: string) {
    setConfirming(proposalId);
    setError('');
    try {
      const response = await fetch(
        `/api/v1/coach/proposals/${proposalId}/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmed: true }),
        },
      );
      const envelope = await readEnvelope<ConfirmResult>(response);
      if (!response.ok || !envelope.data)
        throw new Error(
          errorMessage(envelope.error?.code, envelope.error?.message),
        );
      setProposals((current) =>
        current.map((proposal) =>
          proposal.id === proposalId ? envelope.data!.proposal : proposal,
        ),
      );
      setRoles((current) =>
        current.map((row) =>
          row.opportunity.id === envelope.data!.opportunity.id
            ? { ...row, opportunity: envelope.data!.opportunity }
            : row,
        ),
      );
      await loadRoles();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The status suggestion could not be confirmed.',
      );
    } finally {
      setConfirming(null);
    }
  }

  const context = opportunityId
    ? (roles.find((row) => row.opportunity.id === opportunityId)?.job.title ??
      'This role')
    : 'Your career workspace';
  const visibleProposals = proposals.filter(
    (proposal) =>
      proposal.kind === 'save_discovered_job' ||
      !opportunityId ||
      proposal.opportunityId === opportunityId,
  );
  const shouldLinkToDiscover = messages.some(
    (message) =>
      message.author === 'oppa' && message.text.includes(EMPTY_DISCOVERY_REPLY),
  );
  const allowanceResetTime = coachAllowance?.resetAt
    ? new Date(coachAllowance.resetAt).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  return (
    <>
      <ChatPanel
        messages={messages}
        onSend={(text) => {
          void sendMessage(text);
        }}
        onClose={onClose}
        context={context}
        pending={pending}
        placeholder={
          opportunityId
            ? 'Ask about this role…'
            : 'Ask Oppa anything about your search'
        }
        maxLength={COACH_MESSAGE_MAX_CHARS}
      >
        {loading && !loaded && (
          <p className={s.intro} role="status">
            Loading your coach workspace…
          </p>
        )}
        {!loading && loaded && messages.length === 0 && (
          <p className={s.intro}>
            Ask about your profile, saved roles, or what to do next.
          </p>
        )}
        {coachAllowance && coachAllowance.remaining <= 5 && (
          <div className={s.intro} role="status">
            <p>
              {coachAllowance.remaining > 0
                ? `${coachAllowance.remaining} coach message${coachAllowance.remaining === 1 ? '' : 's'} remaining. Slots renew over the next 24 hours.`
                : `Your next coach message slot opens around ${allowanceResetTime ?? 'soon'}.`}
            </p>
            {coachAllowance.remaining === 0 && (
              <p>
                You can still <a href="/workspace?view=roles&add=1">paste a job for review</a>, browse{' '}
                <a href="/workspace/discover">collected matches</a>, or open{' '}
                <a href="/workspace?view=roles">My roles</a>.
              </p>
            )}
          </div>
        )}
        {aiOff && (
          <p className={s.intro} role="status">
            {errorMessage('AI_NOT_CONFIGURED')} Your roles, CVs and documents
            still work as usual.
          </p>
        )}
        {shouldLinkToDiscover && (
          <p>
            <a href="/workspace/discover">Open Discover</a>
          </p>
        )}
        {error && (
          <div className={s.error} role="alert">
            <p>{error}</p>
            {dailyLimitReached && (
              <p>
                You can still <a href="/workspace?view=roles&add=1">paste a job for review</a>, browse{' '}
                <a href="/workspace/discover">collected matches</a>, or open{' '}
                <a href="/workspace?view=roles">My roles</a>.
              </p>
            )}
            <Button
              variant="text"
              type="button"
              onClick={() => void retryLoad()}
              disabled={loading}
            >
              Try again
            </Button>
          </div>
        )}
        {!!visibleProposals.length && (
          <section className={s.proposalList} aria-label="Coach suggestions">
            {visibleProposals.map((proposal) => {
              if (proposal.kind === 'save_discovered_job')
                return (
                  <article className={s.proposal} key={proposal.id}>
                    <small>
                      {proposal.confirmedAt
                        ? 'Saved role'
                        : 'Review this role'}
                    </small>
                    <h3>{proposal.data.title}</h3>
                    <p>{proposal.data.company}</p>
                    <p>
                      <a
                        href={proposal.data.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View job listing
                      </a>
                    </p>
                    <div className={s.proposalActions}>
                      {proposal.confirmedAt ? (
                        <span>Role saved.</span>
                      ) : (
                        <Button
                          variant="primary"
                          type="button"
                          disabled={confirming !== null}
                          onClick={() => void confirmProposal(proposal.id)}
                        >
                          {confirming === proposal.id
                            ? 'Saving…'
                            : 'Save this role'}
                        </Button>
                      )}
                    </div>
                  </article>
                );
              const current = roles.find(
                (row) => row.opportunity.id === proposal.opportunityId,
              )?.opportunity.status;
              return (
                <article className={s.proposal} key={proposal.id}>
                  <small>
                    {proposal.confirmedAt
                      ? 'Confirmed status change'
                      : 'Review this change'}
                  </small>
                  <h3>
                    {label(proposal.data.from)} to {label(proposal.data.to)}
                  </h3>
                  <p>{proposal.data.reason}</p>
                  {current && <p>Current status: {label(current)}</p>}
                  <div className={s.proposalActions}>
                    {proposal.confirmedAt ? (
                      <span>Status change confirmed.</span>
                    ) : (
                      <Button
                        variant="primary"
                        type="button"
                        disabled={confirming !== null}
                        onClick={() => void confirmProposal(proposal.id)}
                      >
                        {confirming === proposal.id
                          ? 'Confirming…'
                          : `Confirm ${label(proposal.data.to)}`}
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </ChatPanel>
    </>
  );
}

export default CoachWorkspacePanel;
