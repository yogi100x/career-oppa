import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
const { recordPublishingCallback } = vi.hoisted(() => ({
  recordPublishingCallback: vi.fn(),
}));
vi.mock('@career-workspace/core/publishing', () => ({
  recordPublishingCallback,
}));
const secret = 'development-test-secret';
function notification(tamper = false, eventId = 'event-1') {
  const raw = JSON.stringify({
    id: eventId,
    event: 'post.published',
    post: {
      id: 'provider-post',
      platforms: [
        {
          platform: 'linkedin',
          accountId: 'account-1',
          status: 'published',
          publishedUrl: 'https://example.com/post',
        },
      ],
    },
  });
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  return new Request('http://localhost:3000/api/v1/publishing/webhook', {
    method: 'POST',
    body: tamper ? raw.replace('account-1', 'account-2') : raw,
    headers: {
      'x-zernio-signature': signature,
      'x-zernio-event-id': 'event-1',
    },
  });
}
beforeEach(() => {
  vi.stubEnv('FEATURE_PUBLISHING', 'true');
  vi.stubEnv('ZERNIO_WEBHOOK_SECRET', secret);
  recordPublishingCallback.mockReset();
  recordPublishingCallback.mockResolvedValue({ duplicate: false });
});
afterEach(() => vi.unstubAllEnvs());
describe('verified publishing callbacks', () => {
  it('verifies actual raw-body HMAC and stores only terminal account fields', async () => {
    expect((await POST(notification())).status).toBe(200);
    expect(recordPublishingCallback).toHaveBeenCalledWith(
      'event-1:account-1',
      'provider-post',
      {
        status: 'published',
        accountId: 'account-1',
        platform: 'linkedin',
        publicUrl: 'https://example.com/post',
      },
    );
  });
  it('rejects modified bodies and conflicting event IDs', async () => {
    expect((await POST(notification(true))).status).toBe(401);
    expect((await POST(notification(false, 'different'))).status).toBe(400);
    expect(recordPublishingCallback).not.toHaveBeenCalled();
  });
  it('allows provider redelivery after a database failure', async () => {
    recordPublishingCallback.mockRejectedValueOnce(new Error('offline'));
    expect((await POST(notification())).status).toBe(500);
    expect((await POST(notification())).status).toBe(200);
  });
  it('does no work while publishing is switched off', async () => {
    vi.stubEnv('FEATURE_PUBLISHING', 'false');
    expect((await POST(notification())).status).toBe(404);
    expect(recordPublishingCallback).not.toHaveBeenCalled();
  });
});
