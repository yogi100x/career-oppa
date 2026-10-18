import { checkoutSchema } from '@career-workspace/contracts';
import { ApiError, checkRateLimit } from '@career-workspace/core';
import {
  createCreditCheckout,
  PaymentsNotConfiguredError,
} from '@career-workspace/adapters/payments';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';
const productEnv = {
  starter: 'DODO_PRODUCT_STARTER',
  job_hunt: 'DODO_PRODUCT_JOBHUNT',
  full_season: 'DODO_PRODUCT_FULLSEASON',
} as const;

export const POST = createApiHandler({
  authenticate: authenticateApi,
  schema: checkoutSchema,
  handler: async ({ user, input, request }) => {
    const key = request.headers.get('idempotency-key') ?? '';
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
      throw new ApiError(400, 'INVALID_INPUT', 'Provide a valid request key.');
    const limit = await checkRateLimit(user.id, 'credit_checkout', {
      limit: 10,
      windowMs: 60_000,
    });
    if (!limit.allowed)
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Wait a minute before opening another checkout.',
      );
    try {
      return await createCreditCheckout({
        userId: user.id,
        packId: input.packId,
        productId: process.env[productEnv[input.packId]] ?? '',
        idempotencyKey: key,
      });
    } catch (error) {
      if (error instanceof PaymentsNotConfiguredError)
        throw new ApiError(
          503,
          'PAYMENTS_NOT_CONFIGURED',
          'Credit purchases are not available yet. Your balance has not changed.',
        );
      throw new ApiError(
        502,
        'CHECKOUT_FAILED',
        'Checkout could not be opened. Your balance has not changed; try again.',
      );
    }
  },
});
