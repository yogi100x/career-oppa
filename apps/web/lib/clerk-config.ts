const PLACEHOLDER_VALUE = /placeholder|your[_ -]?key|replace[_ -]?me|example|dummy|todo/i;

function hasRealKey(value: string | undefined, prefix: string): boolean {
  return Boolean(
    value &&
      value.startsWith(prefix) &&
      value.length > prefix.length + 16 &&
      !PLACEHOLDER_VALUE.test(value),
  );
}

export function isClerkConfigured(): boolean {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;

  return (
    (hasRealKey(publishableKey, "pk_test_") ||
      hasRealKey(publishableKey, "pk_live_")) &&
    (hasRealKey(secretKey, "sk_test_") || hasRealKey(secretKey, "sk_live_"))
  );
}
