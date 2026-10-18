import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const { recordPaymentEvent } = vi.hoisted(() => ({
  recordPaymentEvent: vi.fn(),
}));
vi.mock('@career-workspace/core/payments', () => ({ recordPaymentEvent }));
const keyBytes = Buffer.from('development-test-secret-not-a-real-key');
const secret = `whsec_${keyBytes.toString('base64')}`;

function notification(tamper = false) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = 'test-webhook-refund';
  const body = JSON.stringify({
    business_id: 'test-business',
    type: 'refund.succeeded',
    timestamp: new Date().toISOString(),
    data: {
      payload_type: 'Refund',
      brand_id: 'test-brand',
      business_id: 'test-business',
      created_at: new Date().toISOString(),
      customer: {
        customer_id: 'test-customer',
        email: 'test@example.com',
        name: 'Test Buyer',
      },
      is_partial: false,
      metadata: {},
      payment_id: 'test-payment',
      refund_id: 'test-refund',
      status: 'succeeded',
      amount: 500,
      currency: 'USD',
    },
  });
  const signature = createHmac('sha256', keyBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return new NextRequest('http://localhost:3000/api/v1/payments/webhook', {
    method: 'POST',
    body: tamper ? body.replace('500', '501') : body,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
  });
}

beforeEach(() => {
  vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', secret);
  recordPaymentEvent.mockReset();
  recordPaymentEvent.mockResolvedValue({
    duplicate: false,
    action: 'refund_debited',
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('signed Dodo notifications', () => {
  it('verifies the actual signature before passing a refund to the ledger', async () => {
    expect((await POST(notification())).status).toBe(200);
    expect(recordPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: 'test-webhook-refund',
        type: 'refund.succeeded',
        refund: {
          refundId: 'test-refund',
          paymentId: 'test-payment',
          isPartial: false,
          status: 'succeeded',
          amountMinor: 500,
          currency: 'USD',
        },
      }),
    );
    const saved = recordPaymentEvent.mock.calls[0][0];
    expect(saved.payload).not.toHaveProperty('customer');
  });
  it('refuses a changed body and never writes credits', async () => {
    expect((await POST(notification(true))).status).toBe(401);
    expect(recordPaymentEvent).not.toHaveBeenCalled();
  });
  it('returns a retryable failure when the ledger write fails', async () => {
    recordPaymentEvent.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await POST(notification())).status).toBe(500);
  });
  it('reports missing setup instead of acknowledging the notification', async () => {
    vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', 'REPLACE_WITH_SECRET');
    expect((await POST(notification())).status).toBe(503);
    expect(recordPaymentEvent).not.toHaveBeenCalled();
  });
});
