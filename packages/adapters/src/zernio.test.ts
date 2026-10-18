import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createZernioProfile,
  deleteZernioProfile,
  disconnectZernioAccount,
  findZernioPost,
  getZernioConnectUrl,
  getZernioPost,
  listZernioAccounts,
  publishZernioPost,
  verifyZernioSignature,
  ZernioError,
} from './zernio';

const key = 'recorded-zernio-test-key';
const profileId = 'profile_fixture_00000001';
const accountId = 'account_fixture_000001';
const apiURL = 'https://zernio.com/api/v1';
const post = {
  _id: 'post_fixture_00000001',
  content: 'A recorded practice update.',
  status: 'published',
  platforms: [{ platform: 'linkedin', accountId, status: 'published', platformPostUrl: 'https://www.linkedin.com/feed/update/fixture' }],
};
function jsonFetch(payload: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload, { status }));
}

describe('Zernio social connection adapter', () => {
  it('creates a stable user profile with the documented auth and idempotency headers', async () => {
    const fetch = jsonFetch({ profile: { _id: profileId, name: 'Career Workspace user-a' } }, 201);
    await expect(createZernioProfile('user-a', { apiKey: key, fetch })).resolves.toBe(profileId);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${apiURL}/profiles`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('career-profile:user-a');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Career Workspace user-a' });
  });

  it('requests a hosted OAuth URL using the server supplied profile and safe return URL', async () => {
    const fetch = jsonFetch({ authUrl: 'https://www.linkedin.com/oauth/authorize?state=fixture' });
    await expect(getZernioConnectUrl(profileId, 'linkedin', 'https://career.example.test/api/social/callback', { apiKey: key, fetch }))
      .resolves.toBe('https://www.linkedin.com/oauth/authorize?state=fixture');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain(`${apiURL}/connect/linkedin?`);
    const query = new URL(String(url)).searchParams;
    expect(query.get('profileId')).toBe(profileId);
    expect(query.get('redirect_url')).toBe('https://career.example.test/api/social/callback');
    expect(init?.method).toBe('GET');
  });

  it('rejects unsafe OAuth return and provider URLs', async () => {
    const fetch = jsonFetch({ authUrl: 'http://not-secure.example.test/oauth' });
    await expect(getZernioConnectUrl(profileId, 'linkedin', 'https://career.example.test/callback', { apiKey: key, fetch }))
      .rejects.toBeInstanceOf(ZernioError);
    await expect(getZernioConnectUrl(profileId, 'linkedin', '/callback', { apiKey: key, fetch }))
      .rejects.toThrow('HTTPS');
  });

  it('lists only accounts whose returned profile matches, even when the provider ignores its filter', async () => {
    const fetch = jsonFetch({ accounts: [
      { _id: accountId, profileId: { _id: profileId, name: 'Fixture' }, platform: 'linkedin', username: 'candidate', isActive: true },
      { _id: 'account_other_000001', profileId: 'another_profile_00001', platform: 'linkedin', username: 'someone-else', isActive: true },
    ] });
    await expect(listZernioAccounts(profileId, { apiKey: key, fetch })).resolves.toEqual([
      { _id: accountId, profileId, platform: 'linkedin', username: 'candidate', isActive: true },
    ]);
    const [url] = fetch.mock.calls[0]!;
    expect(url).toBe(`${apiURL}/accounts?profileId=${profileId}`);
  });

  it('publishes now with the exact account and a stable provider retry key', async () => {
    const fetch = jsonFetch({ message: 'Post published successfully', post }, 201);
    await expect(publishZernioPost({
      content: post.content,
      platform: 'linkedin',
      accountId,
      idempotencyKey: 'post-attempt-fixture-1',
    }, { apiKey: key, fetch })).resolves.toEqual(post);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${apiURL}/posts`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('post-attempt-fixture-1');
    expect(JSON.parse(String(init?.body))).toEqual({
      content: post.content,
      publishNow: true,
      platforms: [{ platform: 'linkedin', accountId }],
    });
  });

  it('fetches a post by its encoded id and reconciles an exact post from a scoped list', async () => {
    const singleFetch = jsonFetch({ post });
    await expect(getZernioPost('post/id with spaces', { apiKey: key, fetch: singleFetch })).resolves.toEqual(post);
    expect(singleFetch.mock.calls[0]?.[0]).toBe(`${apiURL}/posts/post%2Fid%20with%20spaces`);

    const listFetch = jsonFetch({
      posts: [
        { ...post, platforms: [{ platform: 'linkedin', accountId: { _id: accountId }, status: 'published' }] },
        { ...post, _id: 'other_post_000001', content: 'Different content.' },
      ],
      pagination: { pages: 1 },
    });
    await expect(findZernioPost({
      profileId,
      accountId,
      platform: 'linkedin',
      content: post.content,
      fromDate: new Date('2026-10-01T00:00:00.000Z'),
    }, { apiKey: key, fetch: listFetch })).resolves.toEqual({
      ...post,
      platforms: [{ platform: 'linkedin', accountId, status: 'published' }],
    });
    const [listUrl] = listFetch.mock.calls[0]!;
    const query = new URL(String(listUrl)).searchParams;
    expect(query.get('profileId')).toBe(profileId);
    expect(query.get('accountId')).toBe(accountId);
    expect(query.get('platform')).toBe('linkedin');
    expect(query.get('fromDate')).toBe('2026-10-01T00:00:00.000Z');
    expect(query.get('page')).toBe('1');
    expect(query.get('limit')).toBe('100');
    expect(query.get('sortBy')).toBe('created-desc');
  });

  it('disconnects an account and deletes a profile through documented resource paths', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await disconnectZernioAccount('account/id', { apiKey: key, fetch });
    await deleteZernioProfile('profile/id', { apiKey: key, fetch });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${apiURL}/accounts/account%2Fid`, 'DELETE'],
      [`${apiURL}/profiles/profile%2Fid`, 'DELETE'],
    ]);
  });

  it('fails closed for missing keys, malformed provider payloads and unexpected statuses', async () => {
    await expect(createZernioProfile('user-a', { apiKey: 'REPLACE_WITH_ZERNIO_KEY', fetch: vi.fn() }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(listZernioAccounts(profileId, { apiKey: key, fetch: jsonFetch({ accounts: [{ _id: 'bad' }] }) }))
      .rejects.toBeInstanceOf(ZernioError);
    await expect(getZernioPost('post-a', { apiKey: key, fetch: jsonFetch({ error: 'not found' }, 404) }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', status: 404 });
  });

  it('verifies the provider HMAC against the raw body without accepting bad signatures', () => {
    const rawBody = '{"id":"fixture","event":"webhook.test"}';
    const secret = 'recorded-zernio-webhook-secret';
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(verifyZernioSignature(rawBody, signature, secret)).toBe(true);
    expect(verifyZernioSignature(`${rawBody} `, signature, secret)).toBe(false);
    expect(verifyZernioSignature(rawBody, '0'.repeat(64), secret)).toBe(false);
    expect(verifyZernioSignature(rawBody, signature, 'REPLACE_WITH_SECRET')).toBe(false);
    expect(verifyZernioSignature(rawBody, null, secret)).toBe(false);
  });
});
