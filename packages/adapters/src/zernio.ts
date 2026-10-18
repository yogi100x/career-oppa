import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const apiBase = 'https://zernio.com/api/v1';
const accountIdSchema = z
  .union([z.string(), z.object({ _id: z.string() })])
  .transform((value) => (typeof value === 'string' ? value : value._id));
export const zernioPostSchema = z.object({
  _id: z.string().min(1),
  content: z.string().optional(),
  status: z.enum([
    'draft',
    'scheduled',
    'publishing',
    'published',
    'partial',
    'failed',
    'cancelled',
  ]),
  createdAt: z.string().optional(),
  platforms: z
    .array(
      z.object({
        platform: z.string(),
        accountId: accountIdSchema.optional(),
        status: z.string(),
        platformPostUrl: z.string().optional(),
      }),
    )
    .optional(),
});
export type ZernioPost = z.infer<typeof zernioPostSchema>;
export type ZernioOptions = { fetch?: typeof fetch; apiKey?: string };
export class ZernioError extends Error {
  constructor(
    public code: 'NOT_CONFIGURED' | 'PROVIDER_ERROR' | 'INVALID_RESPONSE',
    public status = 503,
  ) {
    super(
      code === 'NOT_CONFIGURED'
        ? 'Social publishing is not configured.'
        : 'The publishing provider could not complete this request.',
    );
  }
}

function parseProvider<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ZernioError('INVALID_RESPONSE', 502);
  return parsed.data;
}

async function call(
  path: string,
  init: RequestInit,
  options: ZernioOptions = {},
): Promise<unknown> {
  const key = options.apiKey ?? process.env.ZERNIO_API_KEY;
  if (!key || key.startsWith('REPLACE_WITH_'))
    throw new ZernioError('NOT_CONFIGURED');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${key}`);
  headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${apiBase}${path}`, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ZernioError('PROVIDER_ERROR', 502);
  }
  if (!response.ok) throw new ZernioError('PROVIDER_ERROR', response.status);
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length > 2_000_000) throw new ZernioError('INVALID_RESPONSE', 502);
  try {
    return JSON.parse(text);
  } catch {
    throw new ZernioError('INVALID_RESPONSE', 502);
  }
}

export async function createZernioProfile(
  userId: string,
  options: ZernioOptions = {},
) {
  const value = await call(
    '/profiles',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': `career-profile:${userId}` },
      body: JSON.stringify({ name: `Career Workspace ${userId}` }),
    },
    options,
  );
  return parseProvider(
    z.object({ profile: z.object({ _id: z.string().min(1) }) }),
    value,
  ).profile._id;
}

export async function getZernioConnectUrl(
  profileId: string,
  platform: string,
  redirectUrl: string,
  options: ZernioOptions = {},
) {
  let returnUrl: URL;
  try {
    returnUrl = new URL(redirectUrl);
  } catch {
    throw new Error('Use a configured HTTPS connection return URL.');
  }
  if (
    returnUrl.protocol !== 'https:' &&
    !(returnUrl.hostname === 'localhost' && returnUrl.protocol === 'http:')
  )
    throw new Error('Use a configured HTTPS connection return URL.');
  const query = new URLSearchParams({ profileId, redirect_url: redirectUrl });
  const result = parseProvider(
    z.object({ authUrl: z.url() }),
    await call(
        `/connect/${encodeURIComponent(platform)}?${query}`,
        { method: 'GET' },
        options,
      ),
  );
  let authProtocol: string;
  try {
    authProtocol = new URL(result.authUrl).protocol;
  } catch {
    throw new ZernioError('INVALID_RESPONSE', 502);
  }
  if (authProtocol !== 'https:') throw new ZernioError('INVALID_RESPONSE', 502);
  return result.authUrl;
}

export async function listZernioAccounts(
  profileId: string,
  options: ZernioOptions = {},
) {
  const query = new URLSearchParams({ profileId });
  const result = parseProvider(
    z.object({
      accounts: z.array(
        z.object({
          _id: z.string(),
          profileId: accountIdSchema,
          platform: z.string(),
          username: z.string().optional(),
          displayName: z.string().optional(),
          isActive: z.boolean(),
        }),
      ),
    }),
    await call(`/accounts?${query}`, { method: 'GET' }, options),
  );
  return result.accounts.filter((account) => account.profileId === profileId);
}

export async function publishZernioPost(
  input: {
    content: string;
    platform: string;
    accountId: string;
    idempotencyKey: string;
  },
  options: ZernioOptions = {},
): Promise<ZernioPost> {
  const result = await call(
    '/posts',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        content: input.content,
        publishNow: true,
        platforms: [{ platform: input.platform, accountId: input.accountId }],
      }),
    },
    options,
  );
  return parseProvider(z.object({ post: zernioPostSchema }), result).post;
}
export async function getZernioPost(
  postId: string,
  options: ZernioOptions = {},
): Promise<ZernioPost> {
  return parseProvider(
    z.object({ post: zernioPostSchema }),
    await call(
        `/posts/${encodeURIComponent(postId)}`,
        { method: 'GET' },
        options,
      ),
  ).post;
}

/** A missing match is inconclusive; callers must preserve the original retry key. */
export async function findZernioPost(
  input: {
    profileId: string;
    accountId: string;
    platform: string;
    content: string;
    fromDate: Date;
  },
  options: ZernioOptions = {},
): Promise<ZernioPost | null> {
  const matches: ZernioPost[] = [];
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      profileId: input.profileId,
      accountId: input.accountId,
      platform: input.platform,
      fromDate: input.fromDate.toISOString(),
      page: String(page),
      limit: '100',
      sortBy: 'created-desc',
    });
    const result = parseProvider(
      z.object({
        posts: z.array(zernioPostSchema),
        pagination: z.object({ pages: z.number().int().nonnegative() }),
      }),
      await call(`/posts?${query}`, { method: 'GET' }, options),
    );
    matches.push(
      ...result.posts.filter(
        (post) =>
          post.content === input.content &&
          post.platforms?.some(
            (target) =>
              target.platform === input.platform &&
              target.accountId === input.accountId,
          ),
      ),
    );
    if (matches.length > 1) throw new ZernioError('INVALID_RESPONSE', 502);
    if (page >= result.pagination.pages) return matches[0] ?? null;
  }
  throw new ZernioError('INVALID_RESPONSE', 502);
}

export async function disconnectZernioAccount(
  accountId: string,
  options: ZernioOptions = {},
) {
  await call(
    `/accounts/${encodeURIComponent(accountId)}`,
    { method: 'DELETE' },
    options,
  );
}
export async function deleteZernioProfile(
  profileId: string,
  options: ZernioOptions = {},
) {
  await call(
    `/profiles/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' },
    options,
  );
}

export function verifyZernioSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (
    !signature ||
    !/^[a-f0-9]{64}$/i.test(signature) ||
    !secret ||
    secret.startsWith('REPLACE_WITH_')
  )
    return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
