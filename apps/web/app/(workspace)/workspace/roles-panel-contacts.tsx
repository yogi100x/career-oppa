'use client';

import { useCallback, useEffect, useState } from 'react';
import CreditRecovery from '../../../components/workspace/credit-recovery';
import styles from './roles-panel-contacts.module.css';

type Contact = {
  id: string;
  name: string;
  title: string;
  companyName: string;
  email: string | null;
  emailStatus: string;
  revealedAt: string | null;
  source: string;
  sourceDate: string | null;
};
type Outreach = {
  id: string;
  contactId: string;
  subject: string;
  body: string;
  factIds: string[];
  status: string;
};
type Api<T> = { data?: T; error?: { code?: string; message?: string } };

async function json<T>(response: Response): Promise<Api<T>> {
  return (await response.json()) as Api<T>;
}

export default function RoleContacts({
  opportunityId,
}: {
  opportunityId: string;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [drafts, setDrafts] = useState<Outreach[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [taskState, setTaskState] = useState('');
  const [edits, setEdits] = useState<
    Record<string, { subject: string; body: string }>
  >({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const [contactResponse, draftResponse] = await Promise.all([
        fetch(`/api/v1/opportunities/${opportunityId}/contacts`, {
          cache: 'no-store',
        }),
        fetch(`/api/v1/opportunities/${opportunityId}/outreach`, {
          cache: 'no-store',
        }),
      ]);
      const [contactBody, draftBody] = await Promise.all([
        json<{ contacts: Contact[] }>(contactResponse),
        json<Outreach[]>(draftResponse),
      ]);
      if (!contactResponse.ok || !draftResponse.ok)
        throw new Error('Contacts and outreach could not be loaded.');
      setContacts(contactBody.data?.contacts ?? []);
      setDrafts(draftBody.data ?? []);
      setLoaded(true);
      setLoadError('');
    } catch (cause) {
      setLoadError('Contacts and outreach could not be loaded. Try again.');
      throw cause;
    }
  }, [opportunityId]);

  useEffect(() => {
    let active = true;
    void load()
      .catch(() => {
        if (active)
          setLoadError('Contacts and outreach could not be loaded. Try again.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  async function retryLoad() {
    setLoadError('');
    if (!loaded) setLoading(true);
    try {
      await load();
    } catch {
      setLoadError('Contacts and outreach could not be loaded. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function searchContacts() {
    setBusy(true);
    setError('');
    setNotice('');
    setTaskState('Searching for relevant people…');
    try {
      const response = await fetch(
        `/api/v1/opportunities/${opportunityId}/contacts/search`,
        {
          method: 'POST',
          headers: { 'idempotency-key': crypto.randomUUID() },
        },
      );
      const body = await json<{ task: { id: string; status: string } }>(
        response,
      );
      if (!response.ok || !body.data?.task)
        throw new Error(
          body.error?.message ?? 'The contact search could not start.',
        );
      let status = body.data.task.status;
      for (
        let attempt = 0;
        attempt < 30 && status !== 'succeeded' && status !== 'failed';
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const poll = await fetch(`/api/v1/tasks/${body.data.task.id}`, {
          cache: 'no-store',
        });
        const result = await json<{ status: string; error: string | null }>(
          poll,
        );
        if (!poll.ok || !result.data)
          throw new Error(
            result.error?.message ?? 'Search status could not be checked.',
          );
        status = result.data.status;
        if (status === 'failed')
          throw new Error(
            result.data.error === 'GETLEADS_NOT_CONFIGURED'
              ? 'Contact search is not configured yet.'
              : 'Contact search did not finish. Try again later.',
          );
      }
      if (status !== 'succeeded')
        throw new Error(
          'Contact search is still running. You can refresh this page to check results.',
        );
      await load();
      setTaskState('');
      setNotice('Contact search finished.');
    } catch (cause) {
      setTaskState('');
      setError(
        cause instanceof Error ? cause.message : 'Contact search failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function reveal(contact: Contact) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/contacts/${contact.id}/reveal`, {
        method: 'POST',
      });
      const body = await json<{
        contact: Contact;
        charged: boolean;
        alreadyRevealed: boolean;
      }>(response);
      if (!response.ok || !body.data)
        throw new Error(
          body.error?.message ?? 'The contact email could not be revealed.',
        );
      await load();
      setNotice(
        body.data.alreadyRevealed
          ? 'This address was already revealed; no credits were charged.'
          : 'Email revealed. 5 credits were charged.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The contact email could not be revealed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function createDraft(contact: Contact) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(
        `/api/v1/opportunities/${opportunityId}/outreach`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({ contactId: contact.id }),
        },
      );
      const body = await json<Outreach>(response);
      if (!response.ok || !body.data)
        throw new Error(
          body.error?.message ?? 'The message could not be drafted.',
        );
      await load();
      setEdits((current) => ({
        ...current,
        [body.data!.id]: { subject: body.data!.subject, body: body.data!.body },
      }));
      setNotice(
        'Draft created. Review every line before using it. 1 credit was charged.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The message could not be drafted.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft(draft: Outreach) {
    const content = edits[draft.id] ?? {
      subject: draft.subject,
      body: draft.body,
    };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/outreach/${draft.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...content, fact_ids: draft.factIds }),
      });
      const body = await json<Outreach>(response);
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? 'The draft could not be saved.');
      await load();
      setNotice('Draft saved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The draft could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handoff(draft: Outreach, method: 'copy' | 'mailto') {
    const content = edits[draft.id] ?? {
      subject: draft.subject,
      body: draft.body,
    };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/outreach/${draft.id}/handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, ...content, method }),
      });
      const body = await json<{
        mailtoUrl: string;
        subject: string;
        body: string;
      }>(response);
      if (!response.ok || !body.data)
        throw new Error(
          body.error?.message ??
            'The reviewed message could not be handed off.',
        );
      if (method === 'copy') {
        await navigator.clipboard.writeText(
          `${body.data.subject}\n\n${body.data.body}`,
        );
        setNotice('Copied to your clipboard. Sending is still up to you.');
      } else {
        window.location.assign(body.data.mailtoUrl);
        setNotice(
          'Your email app should open. The message has not been sent by this app.',
        );
      }
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The message could not be handed off.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function markSent(draft: Outreach) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/outreach/${draft.id}/mark-sent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      const body = await json<Outreach>(response);
      if (!response.ok)
        throw new Error(
          body.error?.message ?? 'The confirmation could not be recorded.',
        );
      await load();
      setNotice('You marked this message as sent. Delivery was not verified.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The confirmation could not be recorded.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function outcome(contactId: string, value: 'reply' | 'opt_out') {
    if (
      !window.confirm(
        value === 'reply'
          ? 'Record that this contact replied? Their follow-up reminder will stop.'
          : 'Record this opt-out? This address will be added to your do-not-contact list.',
      )
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/outcome`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: value, confirmed: true }),
      });
      const body = await json<unknown>(response);
      if (!response.ok)
        throw new Error(
          (body as Api<unknown>).error?.message ??
            'The update could not be saved.',
        );
      await load();
      setNotice(
        value === 'reply'
          ? 'Reply recorded; follow-up reminders stopped.'
          : 'Opt-out recorded; this address is suppressed.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The update could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={styles.panel}
      id="role-contacts"
      aria-labelledby="contacts-title"
    >
      <div className={styles.heading}>
        <div>
          <h2 id="contacts-title">Contacts</h2>
          <p>
            These are company contacts, not confirmed owners of the vacancy.
          </p>
          <p>
            Reaching someone costs up to 6 credits in total: searching is free,
            revealing an email is 5 credits and a reviewed draft is 1 credit.
            You only pay for the steps you choose.
          </p>
        </div>
        {loaded && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void searchContacts()}
          >
            {busy ? 'Working…' : 'Search contacts · free'}
          </button>
        )}
      </div>
      {(error || loadError) && (
        <>
          <p className={styles.error} role="alert">
            {error || loadError}
          </p>
          {error && <CreditRecovery message={error} />}
          {loadError && (
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void retryLoad()}
            >
              Try again
            </button>
          )}
        </>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {taskState && <p role="status">{taskState}</p>}
      {!loaded && loading ? (
        <p role="status">Loading contacts…</p>
      ) : !loaded ? null : contacts.length === 0 ? (
        <p className={styles.empty}>
          No contacts saved for this role yet. Search when contact access is
          configured.
        </p>
      ) : (
        <ul className={styles.contacts}>
          {contacts.map((contact) => {
            const draft = drafts.find(
              (item) =>
                item.contactId === contact.id && item.status !== 'marked_sent',
            );
            const content = draft
              ? (edits[draft.id] ?? {
                  subject: draft.subject,
                  body: draft.body,
                })
              : null;
            return (
              <li className={styles.contact} key={contact.id}>
                <div className={styles.contactHead}>
                  <div>
                    <h3>{contact.name}</h3>
                    <p>
                      {contact.title} · {contact.companyName}
                    </p>
                    <small>
                      Source: {contact.source} ·{' '}
                      {contact.sourceDate
                        ? new Date(contact.sourceDate).toLocaleDateString(
                            'en-GB',
                            { day: 'numeric', month: 'short', year: 'numeric' },
                          )
                        : 'date unavailable'}{' '}
                      · Email{' '}
                      {contact.emailStatus.toLowerCase().replace('_', ' ')}
                    </small>
                  </div>
                  {contact.email ? (
                    <p className={styles.email}>
                      <strong>{contact.email}</strong>
                      <button
                        disabled={busy}
                        onClick={() => void outcome(contact.id, 'reply')}
                      >
                        Record reply
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void outcome(contact.id, 'opt_out')}
                      >
                        Record opt-out
                      </button>
                    </p>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void reveal(contact)}
                    >
                      Reveal email · 5 credits
                    </button>
                  )}
                </div>
                {contact.email && !draft && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void createDraft(contact)}
                  >
                    Draft message · 1 credit
                  </button>
                )}
                {draft && content && (
                  <div className={styles.draft}>
                    <label>
                      Subject
                      <input
                        value={content.subject}
                        disabled={draft.status === 'marked_sent'}
                        onChange={(event) =>
                          setEdits((prev) => ({
                            ...prev,
                            [draft.id]: {
                              ...content,
                              subject: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      Message
                      <textarea
                        rows={7}
                        value={content.body}
                        disabled={draft.status === 'marked_sent'}
                        onChange={(event) =>
                          setEdits((prev) => ({
                            ...prev,
                            [draft.id]: {
                              ...content,
                              body: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <p>
                      Review the whole message and its {draft.factIds.length}{' '}
                      approved supporting fact(s). Handoff checks these facts
                      again.
                    </p>
                    {draft.status === 'marked_sent' ? (
                      <p>
                        You marked this message sent. Delivery was not verified.
                      </p>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void saveDraft(draft)}
                        >
                          Save edits
                        </button>
                        <label className={styles.confirm}>
                          <input
                            type="checkbox"
                            checked={confirmed[draft.id] ?? false}
                            onChange={(event) =>
                              setConfirmed((prev) => ({
                                ...prev,
                                [draft.id]: event.target.checked,
                              }))
                            }
                          />
                          I reviewed this exact subject and message.
                        </label>
                        <div className={styles.actions}>
                          <button
                            type="button"
                            disabled={busy || !confirmed[draft.id]}
                            onClick={() => void handoff(draft, 'copy')}
                          >
                            Copy message
                          </button>
                          <button
                            type="button"
                            disabled={busy || !confirmed[draft.id]}
                            onClick={() => void handoff(draft, 'mailto')}
                          >
                            Open email app
                          </button>
                          {draft.status === 'handed_off' && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void markSent(draft)}
                            >
                              Yes, I sent it
                            </button>
                          )}
                        </div>
                        {draft.status === 'handed_off' && (
                          <p>
                            <strong>Did you send it?</strong> We can’t see your
                            email, so tell us once it has gone and we will
                            remind you to follow up.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
