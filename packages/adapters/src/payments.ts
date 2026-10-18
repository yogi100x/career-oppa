import DodoPayments from 'dodopayments';

export class PaymentsNotConfiguredError extends Error {
  constructor() {
    super('Payments are not configured yet.');
  }
}

type CheckoutInput = {
  userId: string;
  packId: string;
  productId: string;
  idempotencyKey: string;
};

type CheckoutClient = {
  checkoutSessions: {
    create: (
      input: {
        product_cart: { product_id: string; quantity: number }[];
        metadata: Record<string, string>;
        return_url: string;
      },
      options: { idempotencyKey: string },
    ) => Promise<{ checkout_url?: string | null }>;
  };
};

/** Product IDs and return URL come from server configuration, never the browser. */
export async function createCreditCheckout(
  input: CheckoutInput,
  options: { client?: CheckoutClient; returnUrl?: string } = {},
): Promise<{ checkoutUrl: string }> {
  const apiKey = process.env.DODO_PAYMENTS_API_KEY;
  if (
    !input.productId ||
    input.productId.startsWith('REPLACE_WITH_') ||
    (!options.client && (!apiKey || apiKey.startsWith('REPLACE_WITH_')))
  ) {
    throw new PaymentsNotConfiguredError();
  }
  const returnUrl = options.returnUrl ?? process.env.DODO_PAYMENTS_RETURN_URL;
  if (!returnUrl || returnUrl.startsWith('REPLACE_WITH_'))
    throw new PaymentsNotConfiguredError();
  const parsedReturnUrl = new URL(returnUrl);
  const local = ['localhost', '127.0.0.1'].includes(parsedReturnUrl.hostname);
  if (
    parsedReturnUrl.protocol !== 'https:' &&
    !(local && parsedReturnUrl.protocol === 'http:')
  )
    throw new Error(
      'Checkout return URL must use HTTPS outside local development.',
    );
  // Live payments stay disabled until the launch price and refund review.
  if (process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode')
    throw new Error(
      'Live payments require the launch review before activation.',
    );
  const client: CheckoutClient =
    options.client ??
    new DodoPayments({
      bearerToken: apiKey,
      environment: 'test_mode',
      timeout: 15_000,
      maxRetries: 1,
    });
  const checkout = await client.checkoutSessions.create(
    {
      product_cart: [{ product_id: input.productId, quantity: 1 }],
      metadata: { user_id: input.userId, pack_id: input.packId },
      return_url: returnUrl,
    },
    {
      idempotencyKey: `checkout:${input.userId}:${input.packId}:${input.idempotencyKey}`,
    },
  );
  if (!checkout.checkout_url)
    throw new Error('The payment provider did not return a checkout link.');
  const checkoutUrl = new URL(checkout.checkout_url);
  if (checkoutUrl.protocol !== 'https:')
    throw new Error('The payment provider returned an invalid checkout link.');
  return { checkoutUrl: checkoutUrl.toString() };
}
