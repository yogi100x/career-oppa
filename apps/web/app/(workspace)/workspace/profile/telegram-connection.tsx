'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../../components/workspace';
import styles from './telegram-connection.module.css';

type Status = { linked: boolean; linkedAt: string | null };
type LinkCode = { url: string; expiresAt: string };
type ApiBody<T> = { data?: T; error?: { message?: string } };

async function readApi<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiBody<T>;
  if (!response.ok) throw new Error(body.error?.message ?? 'Please try again.');
  if (!body.data)
    throw new Error('The server returned an incomplete response.');
  return body.data;
}

export default function TelegramConnection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [linkCode, setLinkCode] = useState<LinkCode | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const nextStatus = await readApi<Status>(
        await fetch('/api/v1/telegram/link'),
      );
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function connect() {
    setBusy(true);
    setError(null);
    setLinkCode(null);
    try {
      const result = await readApi<LinkCode>(
        await fetch('/api/v1/telegram/link', { method: 'POST' }),
      );
      setLinkCode(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await readApi<{ disconnected: boolean }>(
        await fetch('/api/v1/telegram/link', { method: 'DELETE' }),
      );
      setStatus({ linked: false, linkedAt: null });
      setLinkCode(null);
      setConfirmDisconnect(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="telegram-heading">
      <div className={styles.heading}>
        <h2 id="telegram-heading">Telegram reminders</h2>
        <p>
          Connect Career Oppa to receive follow-up reminders in a private
          Telegram chat.
        </p>
      </div>
      <div className={styles.panel} aria-live="polite">
        <p className={styles.reminderNote}>
          Reminders are on by default after you connect. Send <code>/stop</code>{' '}
          to the bot at any time to stop reminders and remove the connection.
        </p>
        {status === null ? (
          <p className={styles.muted}>
            {error
              ? 'Could not check your Telegram connection.'
              : 'Checking your Telegram connection…'}
          </p>
        ) : status.linked ? (
          <>
            <p className={styles.connected}>
              Connected
              {status.linkedAt
                ? ` on ${new Date(status.linkedAt).toLocaleDateString()}`
                : ''}
              .
            </p>
            {confirmDisconnect ? (
              <div className={styles.confirm}>
                <p>
                  Disconnect Telegram? You will stop receiving reminders there.
                </p>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    type="button"
                    onClick={disconnect}
                    disabled={busy}
                  >
                    {busy ? 'Disconnecting…' : 'Yes, disconnect'}
                  </Button>
                  <Button
                    variant="text"
                    type="button"
                    onClick={() => setConfirmDisconnect(false)}
                    disabled={busy}
                  >
                    Keep connected
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="text"
                type="button"
                onClick={() => setConfirmDisconnect(true)}
                disabled={busy}
              >
                Disconnect Telegram
              </Button>
            )}
          </>
        ) : (
          <>
            <p className={styles.muted}>Not connected.</p>
            <Button
              variant="primary"
              type="button"
              onClick={connect}
              disabled={busy}
            >
              {busy ? 'Creating link…' : 'Connect Telegram'}
            </Button>
            {linkCode && (
              <div className={styles.linkCode}>
                <p>
                  This one-time link expires in 10 minutes. Open it in Telegram
                  and press Start to connect.
                </p>
                <a href={linkCode.url} target="_blank" rel="noreferrer">
                  Open Career Oppa in Telegram
                </a>
                <p className={styles.muted}>
                  Link expires at{' '}
                  {new Date(linkCode.expiresAt).toLocaleTimeString()}.
                </p>
                <Button
                  variant="text"
                  type="button"
                  onClick={() => void refresh()}
                  disabled={busy}
                >
                  I pressed Start — check connection
                </Button>
              </div>
            )}
          </>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {error && status === null && (
          <Button variant="text" type="button" onClick={() => void refresh()}>
            Retry connection check
          </Button>
        )}
      </div>
    </section>
  );
}
