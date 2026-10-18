import { Webhooks } from '@dodopayments/nextjs';
import { NextRequest } from 'next/server';
import { recordPaymentEvent } from '@career-workspace/core/payments';

export const runtime = 'nodejs';
const productEnv = {
  starter: 'DODO_PRODUCT_STARTER',
  job_hunt: 'DODO_PRODUCT_JOBHUNT',
  full_season: 'DODO_PRODUCT_FULLSEASON',
} as const;

export async function POST(request: NextRequest) {
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
  if (!secret || secret.startsWith('REPLACE_WITH_'))
    return Response.json(
      {
        error: {
          code: 'PAYMENTS_NOT_CONFIGURED',
          message: 'Payment notifications are not configured.',
        },
      },
      { status: 503 },
    );
  const webhookId = request.headers.get('webhook-id') ?? '';
  if (!webhookId || webhookId.length > 200)
    return Response.json(
      {
        error: { code: 'INVALID_WEBHOOK', message: 'Missing notification ID.' },
      },
      { status: 400 },
    );
  const handler = Webhooks({
    webhookKey: secret,
    onPayload: async (payload) => {
      if (payload.type === 'payment.succeeded') {
        const data = payload.data;
        const packId = data.metadata.pack_id;
        const userId = data.metadata.user_id;
        if (
          typeof packId !== 'string' ||
          !Object.hasOwn(productEnv, packId) ||
          typeof userId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            userId,
          )
        ) {
          await recordPaymentEvent({
            webhookId,
            type: payload.type,
            payload: {
              paymentId: data.payment_id,
              disposition: 'unrecognized_purchase',
            },
          });
          return;
        }
        const expectedProduct =
          process.env[productEnv[packId as keyof typeof productEnv]];
        const cart = data.product_cart;
        if (!expectedProduct || expectedProduct.startsWith('REPLACE_WITH_'))
          throw new Error('Credit pack product configuration is missing.');
        if (
          !cart ||
          cart.length !== 1 ||
          cart[0].product_id !== expectedProduct ||
          cart[0].quantity !== 1 ||
          data.status !== 'succeeded'
        ) {
          await recordPaymentEvent({
            webhookId,
            type: payload.type,
            payload: {
              paymentId: data.payment_id,
              disposition: 'unrecognized_product',
            },
          });
          return;
        }
        const payment = {
          paymentId: data.payment_id,
          userId,
          packId: packId as keyof typeof productEnv,
          productId: expectedProduct,
          quantity: 1,
          totalAmountMinor: data.total_amount,
          currency: data.currency,
        };
        // Store only ledger-relevant fields; payment/card/customer details stay at Dodo.
        await recordPaymentEvent({
          webhookId,
          type: payload.type,
          payload: { ...payment },
          payment,
        });
      } else if (payload.type === 'refund.succeeded') {
        const data = payload.data;
        const refund = {
          refundId: data.refund_id,
          paymentId: data.payment_id,
          isPartial: data.is_partial,
          status: data.status,
          amountMinor: data.amount ?? undefined,
          currency: data.currency ?? undefined,
        };
        await recordPaymentEvent({
          webhookId,
          type: payload.type,
          payload: { ...refund },
          refund,
        });
      } else {
        await recordPaymentEvent({
          webhookId,
          type: payload.type,
          payload: { type: payload.type },
        });
      }
    },
  });
  try {
    return await handler(request);
  } catch {
    // A failed database write must remain retryable by the provider.
    return Response.json(
      {
        error: {
          code: 'WEBHOOK_FAILED',
          message: 'The notification could not be processed.',
        },
      },
      { status: 500 },
    );
  }
}
