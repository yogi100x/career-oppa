import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch, type Response } from 'undici';
import { isPublicAddress } from './link-fetcher';
import { DiscoverySourceFetchError, type DiscoveryProvider, type DiscoverySource } from './job-discovery';

const DATASET_HOST = 'raw.githubusercontent.com';
const DATASET_BASE = `https://${DATASET_HOST}/Feashliaa/job-board-aggregator/main/data`;
const MAX_DATASET_BYTES = 4 * 1024 * 1024;
const MAX_DATASET_MS = 15_000;
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const PROVIDERS: readonly DiscoveryProvider[] = ['greenhouse', 'lever', 'ashby'];

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
type Transport = (url: URL, address: Address, signal: AbortSignal) => Promise<Response>;
export type DiscoveryCompanyDataset = { sources: DiscoverySource[]; rejected: number };

const safeResolver: Resolver = hostname => dnsLookup(hostname, { all: true, verbatim: true });
const pinnedTransport: Transport = async (url, address, signal) => {
  const agent = new Agent({ autoSelectFamily: false, connect: { lookup: (_host, _opts, cb) => cb(null, address.address, address.family) } });
  try {
    const response = await fetch(url, {
      dispatcher: agent,
      redirect: 'manual',
      signal,
      headers: { Accept: 'application/json', 'User-Agent': 'CareerWorkspace/0.1' },
    });
    Object.defineProperty(response, '_discoveryClose', { value: () => agent.close() });
    return response;
  } catch (error) {
    await agent.destroy();
    throw error;
  }
};

function companyFromSlug(slug: string): string {
  return slug.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()).trim();
}

/** Normalize the public dataset's array-of-slugs format into safe ATS board references. */
export function parseDiscoveryCompanyDataset(provider: DiscoveryProvider, input: unknown): DiscoveryCompanyDataset {
  if (!PROVIDERS.includes(provider)) throw new DiscoverySourceFetchError('malformed', 'Discovery provider is invalid.');
  if (!Array.isArray(input)) throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset has an invalid format.');
  if (input.length > 100_000) throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset has too many entries.');
  const seen = new Set<string>();
  const sources: DiscoverySource[] = [];
  let rejected = 0;
  for (const entry of input) {
    if (typeof entry !== 'string') { rejected += 1; continue; }
    const slug = entry;
    if (!SAFE_SLUG.test(slug)) { rejected += 1; continue; }
    const key = `${provider}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ id: key, provider, board: slug, company: companyFromSlug(slug) });
  }
  if (!sources.length) throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset contains no valid boards.');
  return { sources, rejected };
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readDatasetJson(response: Response): Promise<unknown> {
  if (!response.ok || response.status >= 300) {
    const kind = [404, 410].includes(response.status) ? 'not-found'
      : [403, 429].includes(response.status) ? 'refused'
        : response.status >= 500 ? 'transient' : 'malformed';
    throw new DiscoverySourceFetchError(kind, 'Discovery company dataset request failed.', response.status, retryAfterMs(response));
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset redirected unexpectedly.', response.status);
  }
  const type = response.headers.get('content-type') || '';
  // GitHub's fixed raw JSON URLs are served as text/plain; still parse and validate JSON below.
  if (!/^(?:application\/(?:json|[^;]+\+json)|text\/plain)(?:;|$)/i.test(type)) throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset returned an invalid response.');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_DATASET_BYTES) throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset returned an invalid response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DATASET_BYTES) throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset is too large.');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset contains invalid JSON.'); }
}

/** Fetch the fixed public dataset file, pinning DNS to a public address and refusing redirects. */
export async function fetchDiscoveryCompanyDataset(
  provider: DiscoveryProvider,
  options: { resolver?: Resolver; transport?: Transport; timeoutMs?: number } = {},
): Promise<DiscoveryCompanyDataset> {
  if (!PROVIDERS.includes(provider)) throw new DiscoverySourceFetchError('malformed', 'Discovery provider is invalid.');
  const url = new URL(`${DATASET_BASE}/${provider}_companies.json`);
  if (url.hostname !== DATASET_HOST || url.protocol !== 'https:') throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset URL is invalid.');
  const controller = AbortSignal.timeout(Math.min(MAX_DATASET_MS, Math.max(1, options.timeoutMs ?? MAX_DATASET_MS)));
  let addresses: Address[];
  try {
    addresses = await new Promise<Address[]>((resolve, reject) => {
      const cleanup = () => controller.removeEventListener('abort', onAbort);
      const onAbort = () => { cleanup(); reject(new Error('timeout')); };
      if (controller.aborted) { onAbort(); return; }
      controller.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve().then(() => (options.resolver ?? safeResolver)(DATASET_HOST)).then(
        value => { cleanup(); resolve(value); },
        error => { cleanup(); reject(error); },
      );
    });
  } catch { throw new DiscoverySourceFetchError('transient', 'Discovery company dataset address lookup failed.'); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new DiscoverySourceFetchError('malformed', 'Discovery company dataset address is not public.');
  const address = addresses.find(item => item.family === 4) ?? addresses[0]!;
  let response: Response;
  try { response = await (options.transport ?? pinnedTransport)(url, address, controller); }
  catch { throw new DiscoverySourceFetchError('transient', 'Discovery company dataset could not be reached.'); }
  try { return parseDiscoveryCompanyDataset(provider, await readDatasetJson(response)); }
  finally {
    await response.body?.cancel().catch(() => undefined);
    const close = (response as Response & { _discoveryClose?: () => Promise<void> })._discoveryClose;
    if (close) await close();
  }
}
