'use client';
import Link from 'next/link';
export default function CreditRecovery({
  message,
}: {
  message: string | null;
}) {
  if (
    !message ||
    !/not have enough credits|need \d+ available credits/i.test(message)
  )
    return null;
  const now = new Date();
  const renewal = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  return (
    <aside aria-label="Ways to get credits">
      <p>Your 30 free credits renew on {renewal} (UTC).</p>
      <p>
        <Link href="/workspace/credits#earn">
          Earn credits by submitting a disclosed post
        </Link>{' '}
        or <Link href="/workspace/credits#buy">buy a credit pack</Link>.
      </p>
    </aside>
  );
}
