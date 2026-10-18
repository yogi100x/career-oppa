import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCreditCheckout, PaymentsNotConfiguredError } from './payments';

afterEach(() => vi.unstubAllEnvs());

describe('credit checkout adapter', () => {
  it('uses the fixed product, server user metadata and stable scoped retry key', async () => {
    vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
    const create = vi
      .fn()
      .mockResolvedValue({
        checkout_url: 'https://checkout.dodopayments.com/test',
      });
    await expect(
      createCreditCheckout(
        {
          userId: 'buyer-a',
          packId: 'starter',
          productId: 'product-a',
          idempotencyKey: 'retry-a',
        },
        {
          client: { checkoutSessions: { create } },
          returnUrl: 'http://localhost:3000/workspace/credits',
        },
      ),
    ).resolves.toEqual({
      checkoutUrl: 'https://checkout.dodopayments.com/test',
    });
    expect(create).toHaveBeenCalledWith(
      {
        product_cart: [{ product_id: 'product-a', quantity: 1 }],
        metadata: { user_id: 'buyer-a', pack_id: 'starter' },
        return_url: 'http://localhost:3000/workspace/credits',
      },
      { idempotencyKey: 'checkout:buyer-a:starter:retry-a' },
    );
  });

  it('refuses missing keys instead of pretending checkout succeeded', async () => {
    vi.stubEnv('DODO_PAYMENTS_API_KEY', 'REPLACE_WITH_DODO_TEST_KEY');
    await expect(
      createCreditCheckout({
        userId: 'buyer-a',
        packId: 'starter',
        productId: 'product-a',
        idempotencyKey: 'retry-a',
      }),
    ).rejects.toBeInstanceOf(PaymentsNotConfiguredError);
  });

  it('refuses a live checkout before the launch review', async () => {
    vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'live_mode');
    const create = vi.fn();
    await expect(
      createCreditCheckout(
        {
          userId: 'buyer-a',
          packId: 'starter',
          productId: 'product-a',
          idempotencyKey: 'retry-a',
        },
        {
          client: { checkoutSessions: { create } },
          returnUrl: 'https://example.com/workspace/credits',
        },
      ),
    ).rejects.toThrow('launch review');
    expect(create).not.toHaveBeenCalled();
  });
});
