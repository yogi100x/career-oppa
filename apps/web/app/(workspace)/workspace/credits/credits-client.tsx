'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../../components/workspace';
import styles from './credits.module.css';
import RewardsPanel from './rewards-panel';

type Pack = {
  id: 'starter' | 'job_hunt' | 'full_season';
  name: string;
  priceUsdCents: number;
  credits: number;
};
type LedgerRow = {
  id: string;
  amount: number;
  bucket: 'free' | 'earned' | 'purchased';
  kind:
    'grant' | 'expire' | 'debit' | 'purchase' | 'refund' | 'reward' | 'adjust';
  createdAt: string;
};
type CreditData = {
  available: number;
  buckets: Record<'free' | 'earned' | 'purchased', number>;
  availableBuckets: Record<'free' | 'earned' | 'purchased', number>;
  held: Record<'free' | 'earned' | 'purchased', number>;
  allowance: number;
  actions: Record<string, { cost: number }>;
  history: LedgerRow[];
  packs: Pack[];
};
type ApiBody<T> = { data?: T; error?: { code?: string; message?: string } };

const actionLabels: Record<string, string> = {
  fit_review: 'Review a role',
  tailor_cv: 'Draft a tailored CV',
  answer_draft: 'Draft an application answer',
  outreach_draft: 'Draft an outreach message',
  practice_session: 'Run interview practice',
  post_draft: 'Draft a post',
  contact_reveal: 'Reveal a contact',
};
const packDescriptions: Record<Pack['id'], string> = {
  starter: 'A little extra room to explore.',
  job_hunt: 'More space for an active search.',
  full_season: 'Support for a longer search.',
};

function messageFor(code?: string) {
  if (
    code === 'PAYMENTS_NOT_CONFIGURED' ||
    code === 'DODO_NOT_CONFIGURED' ||
    code === 'CHECKOUT_NOT_CONFIGURED'
  ) {
    return 'Credit purchases are not set up in this environment yet. Your balance and history are still available.';
  }
  return 'We could not complete that request. Please try again.';
}

async function readApi<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiBody<T>;
  if (!response.ok) throw new Error(messageFor(body.error?.code));
  if (!body.data)
    throw new Error('The server returned an incomplete response.');
  return body.data;
}

function money(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function entryLabel(row: LedgerRow) {
  if (row.kind === 'grant') return 'Monthly free credits';
  if (row.kind === 'expire') return 'Unused monthly credits expired';
  if (row.kind === 'debit') return 'Credits used';
  if (row.kind === 'purchase') return 'Credit pack purchased';
  if (row.kind === 'refund') return 'Purchase refunded';
  if (row.kind === 'reward') return 'Credits earned';
  return 'Balance adjustment';
}

export default function CreditsClient() {
  const [data, setData] = useState<CreditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPack, setBusyPack] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await readApi<CreditData>(
          await fetch('/api/v1/credits', { cache: 'no-store' }),
        ),
      );
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Credits could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function buy(packId: Pack['id']) {
    setBusyPack(packId);
    setError('');
    try {
      const body = await readApi<{ checkoutUrl: string }>(
        await fetch('/api/v1/credits/checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({ packId }),
        }),
      );
      const checkout = new URL(body.checkoutUrl);
      if (checkout.protocol !== 'https:')
        throw new Error(
          'The checkout link was not secure. No purchase was started.',
        );
      window.location.assign(checkout.toString());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Checkout could not be started.',
      );
      setBusyPack(null);
    }
  }

  if (loading && !data)
    return (
      <p className={styles.notice} role="status">
        Loading your credit balance…
      </p>
    );
  if (!data)
    return (
      <div className={styles.alert} role="alert">
        <p>{error || 'Your credit balance could not be loaded.'}</p>
        <Button
          variant="secondary"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Trying again…' : 'Try again'}
        </Button>
      </div>
    );

  const actions = Object.entries(data.actions).filter(
    ([key]) => actionLabels[key],
  );

  return (
    <div className={styles.viewport}>
      <div className={styles.layout}>
        {error && (
          <div className={styles.alert} role="alert">
            <p>{error}</p>
            <Button
              variant="text"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? 'Refreshing…' : 'Try again'}
            </Button>
          </div>
        )}
        <section className={styles.balancePanel} aria-label="Credit balance">
          <div className={styles.available}>
            <span>Ready to use</span>
            <strong aria-label={`${data.available} credits available`}>
              {data.available}
            </strong>
            <small>credits available</small>
          </div>
          <div className={styles.bucketList}>
            <div>
              <span>Free this month</span>
              <strong>{data.availableBuckets.free}</strong>
              <small>
                {data.held.free
                  ? `${data.held.free} held for an action`
                  : `Up to ${data.allowance} renew monthly`}
              </small>
            </div>
            <div>
              <span>Earned</span>
              <strong>{data.availableBuckets.earned}</strong>
              <small>Do not expire</small>
            </div>
            <div>
              <span>Purchased</span>
              <strong>{data.availableBuckets.purchased}</strong>
              <small>Do not expire</small>
            </div>
          </div>
          {data.available < 0 && (
            <p className={styles.debtNote}>
              Your balance includes a refund adjustment. New paid actions may be
              unavailable until the balance is positive.
            </p>
          )}
        </section>

        <section className={styles.section} aria-labelledby="costs-title">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="costs-title">What actions cost</h2>
              <p>
                Free actions such as viewing saved roles do not use credits.
              </p>
            </div>
          </div>
          <ul className={styles.costList}>
            {actions.map(([key, action]) => (
              <li key={key}>
                <span>{actionLabels[key]}</span>
                <strong>
                  {action.cost} {action.cost === 1 ? 'credit' : 'credits'}
                </strong>
              </li>
            ))}
          </ul>
        </section>

        <section
          id="buy"
          className={styles.section}
          aria-labelledby="packs-title"
        >
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="packs-title">Add credits</h2>
              <p>One-time purchases. Purchased credits do not expire.</p>
            </div>
          </div>
          {data.packs?.length ? (
            <div className={styles.packGrid}>
              {data.packs.map((pack) => (
                <article className={styles.pack} key={pack.id}>
                  <div>
                    <h3>{pack.name}</h3>
                    <p>{packDescriptions[pack.id]}</p>
                  </div>
                  <p className={styles.packAmount}>
                    <strong>{pack.credits}</strong>
                    <span>credits</span>
                  </p>
                  <div className={styles.packFoot}>
                    <strong>{money(pack.priceUsdCents)}</strong>
                    <small>Charged in US dollars.</small>
                    <Button
                      variant="primary"
                      disabled={busyPack !== null}
                      onClick={() => void buy(pack.id)}
                    >
                      {busyPack === pack.id
                        ? 'Opening checkout…'
                        : 'Choose pack'}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className={styles.notice}>
              Credit packs will appear here when checkout is configured.
            </p>
          )}
        </section>

        <section className={styles.section} aria-labelledby="history-title">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="history-title">Credit history</h2>
              <p>Recent additions, usage and expiry from your own account.</p>
            </div>
          </div>
          {data.history.length ? (
            <div className={styles.historyScroll}>
              <table className={styles.history}>
                <thead>
                  <tr>
                    <th scope="col">Activity</th>
                    <th scope="col">Date</th>
                    <th scope="col">Bucket</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((row) => (
                    <tr key={row.id}>
                      <td>{entryLabel(row)}</td>
                      <td>{new Date(row.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      <td>{row.bucket}</td>
                      <td
                        className={
                          row.amount > 0 ? styles.positive : styles.negative
                        }
                      >
                        {row.amount > 0 ? '+' : ''}
                        {row.amount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.notice}>
              Your credit activity will appear here after your first allowance
              or action.
            </p>
          )}
        </section>
        <RewardsPanel />
      </div>
    </div>
  );
}
