import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import { Agent, fetch, type Response } from 'undici';
import { isPublicAddress } from './link-fetcher';

export type DiscoveryProvider = 'greenhouse' | 'lever' | 'ashby';
export type DiscoverySource = { id: string; provider: DiscoveryProvider; board: string; company: string };
export type PublicDiscoveryJob = {
  sourceId: string;
  provider: DiscoveryProvider;
  externalId: string;
  title: string;
  company: string;
  location: string;
  workMode: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  url: string;
  text: string;
  postedAt: string | null;
};

/** Six seed boards retained for existing callers while dataset discovery is introduced. */
export const DISCOVERY_SEED_SOURCES: readonly DiscoverySource[] = [
  { id: 'greenhouse:figma', provider: 'greenhouse', board: 'figma', company: 'Figma' },
  { id: 'greenhouse:gitlab', provider: 'greenhouse', board: 'gitlab', company: 'GitLab' },
  { id: 'lever:palantir', provider: 'lever', board: 'palantir', company: 'Palantir' },
  { id: 'lever:spotify', provider: 'lever', board: 'spotify', company: 'Spotify' },
  { id: 'ashby:notion', provider: 'ashby', board: 'notion', company: 'Notion' },
  { id: 'ashby:linear', provider: 'ashby', board: 'linear', company: 'Linear' },
] as const;
/** Backwards compatible seed alias. The runtime dataset is fetched separately. */
export const DISCOVERY_SOURCES = DISCOVERY_SEED_SOURCES;

const BOARD_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export type DiscoverySourceErrorKind = 'not-found' | 'refused' | 'transient' | 'malformed';
export class DiscoverySourceFetchError extends Error {
  constructor(readonly kind: DiscoverySourceErrorKind, message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'DiscoverySourceFetchError';
  }
}

export function isValidDiscoverySource(source: unknown): source is DiscoverySource {
  if (!source || typeof source !== 'object') return false;
  const value = source as Partial<DiscoverySource>;
  return (value.provider === 'greenhouse' || value.provider === 'lever' || value.provider === 'ashby')
    && typeof value.board === 'string' && BOARD_SLUG.test(value.board)
    && typeof value.company === 'string' && value.company.trim().length > 0 && value.company.length <= 200
    && value.id === `${value.provider}:${value.board}`;
}
export const isDiscoverySource = isValidDiscoverySource;

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
type Transport = (url: URL, address: Address, signal: AbortSignal) => Promise<Response>;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_JOBS = 2_000;
const MAX_TEXT = 100_000;
const SAFE_JOB_HOSTS: Record<DiscoveryProvider, ReadonlySet<string>> = {
  greenhouse: new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io']),
  lever: new Set(['jobs.lever.co', 'jobs.eu.lever.co']),
  ashby: new Set(['jobs.ashbyhq.com']),
};

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
    // Fetch's body remains usable after the connection agent is closed only after reading.
    Object.defineProperty(response, '_discoveryClose', { value: () => agent.close() });
    return response;
  } catch (error) {
    await agent.destroy();
    throw error;
  }
};

function boardUrl(source: DiscoverySource): URL {
  const board = encodeURIComponent(source.board);
  if (source.provider === 'greenhouse') return new URL(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`);
  if (source.provider === 'lever') return new URL(`https://api.lever.co/v0/postings/${board}?mode=json`);
  return new URL(`https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}
type JsonRecord = Record<string, unknown>;
function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }

function htmlText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const $ = load(value);
  $('script,style,noscript,svg,iframe,template').remove();
  const decoded = $('body').text() || $.root().text();
  // Greenhouse content=true sometimes entity-escapes the entire HTML body.
  // Decode once, then parse the revealed markup as well as ordinary HTML.
  const nested = load(decoded);
  nested('script,style,noscript,svg,iframe,template').remove();
  return boundedText(nested('body').text() || decoded, MAX_TEXT);
}

function safeJobUrl(value: unknown, provider: DiscoveryProvider): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !SAFE_JOB_HOSTS[provider].has(url.hostname.toLowerCase())) return '';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) return '';
    return url.toString();
  } catch { return ''; }
}

function locationAndMode(location: string, explicit?: unknown): { location: string; workMode: PublicDiscoveryJob['workMode'] } {
  const value = typeof explicit === 'string' ? explicit.toLowerCase() : '';
  const text = `${value} ${location}`.toLowerCase();
  const workMode = /remote/.test(text) ? 'remote' : /hybrid/.test(text) ? 'hybrid' : /onsite|on-site|in.office|in person/.test(text) ? 'onsite' : 'unknown';
  return { location, workMode };
}

function dateValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalize(source: DiscoverySource, input: unknown): PublicDiscoveryJob | null {
  const row = asRecord(input);
  let externalId: unknown;
  let title: unknown;
  let company: unknown = source.company;
  let location: unknown;
  let work: unknown;
  let url: unknown;
  let text: unknown;
  let posted: unknown;
  if (source.provider === 'greenhouse') {
    externalId = row.id;
    title = row.title;
    location = asRecord(row.location).name;
    url = row.absolute_url;
    text = row.content;
    // Updating a listing does not establish its original posting date.
    posted = row.first_published;
  } else if (source.provider === 'lever') {
    externalId = row.id;
    title = row.text;
    company = row.company || company;
    const categories = asRecord(row.categories);
    location = [categories.location, ...(Array.isArray(categories.allLocations) ? categories.allLocations : [])].filter(v => typeof v === 'string').join(' · ');
    url = row.hostedUrl;
    text = row.descriptionPlain || row.description;
    posted = row.createdAt;
  } else {
    externalId = row.id;
    title = row.title;
    company = row.companyName || company;
    location = [row.location, ...(Array.isArray(row.secondaryLocations) ? row.secondaryLocations.map(item => asRecord(item).location) : [])].filter(v => typeof v === 'string').join(' · ');
    work = row.workplaceType;
    if (!work && row.isRemote === true) work = 'remote';
    url = row.jobUrl;
    text = row.descriptionPlain || row.descriptionHtml || row.description;
    posted = row.publishedAt;
  }
  if ((typeof externalId !== 'string' && typeof externalId !== 'number') || !String(externalId).trim()) return null;
  const cleanTitle = boundedText(title, 200);
  const cleanCompany = boundedText(company, 200);
  const cleanLocation = boundedText(location, 200);
  const cleanUrl = safeJobUrl(url, source.provider);
  if (!cleanTitle || !cleanCompany || !cleanUrl) return null;
  const normalizedLocation = locationAndMode(cleanLocation, work);
  return {
    sourceId: source.id,
    provider: source.provider,
    externalId: String(externalId).trim().slice(0, 200),
    title: cleanTitle,
    company: cleanCompany,
    location: normalizedLocation.location,
    workMode: normalizedLocation.workMode,
    url: cleanUrl,
    text: typeof text === 'string' ? htmlText(text) : '',
    postedAt: dateValue(posted),
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || response.status >= 300) {
    const retryAfter = response.headers.get('retry-after');
    let retryAfterMs: number | undefined;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = seconds * 1000;
      else if (Number.isFinite(date)) retryAfterMs = Math.max(0, date - Date.now());
    }
    const kind: DiscoverySourceErrorKind = [404, 410].includes(response.status) ? 'not-found'
      : [403, 429].includes(response.status) ? 'refused'
        : response.status >= 500 ? 'transient' : 'malformed';
    throw new DiscoverySourceFetchError(kind, 'Discovery provider request failed.', response.status, retryAfterMs);
  }
  const type = response.headers.get('content-type') || '';
  if (!/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(type)) throw new DiscoverySourceFetchError('malformed', 'Discovery provider returned an invalid response.');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new DiscoverySourceFetchError('malformed', 'Discovery provider response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new DiscoverySourceFetchError('malformed', 'Discovery provider returned an invalid response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new DiscoverySourceFetchError('malformed', 'Discovery provider response is too large.');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DiscoverySourceFetchError('malformed', 'Discovery provider returned invalid JSON.'); }
}

/** Reads one validated board on its fixed public ATS host. */
export async function fetchDiscoveryBoard(
  source: DiscoverySource,
  options: { resolver?: Resolver; transport?: Transport; timeoutMs?: number; onHttpStatus?: (status: number) => void; onRowCounts?: (received: number, normalized: number) => void } = {},
): Promise<PublicDiscoveryJob[]> {
  if (!isValidDiscoverySource(source)) {
    throw new DiscoverySourceFetchError('malformed', 'This discovery board is invalid.');
  }
  const url = boardUrl(source);
  const hostname = url.hostname;
  const controller = AbortSignal.timeout(Math.min(30_000, Math.max(1, options.timeoutMs ?? 30_000)));
  let addresses: Address[];
  try {
    addresses = await new Promise<Address[]>((resolve, reject) => {
      const cleanup = () => controller.removeEventListener('abort', onAbort);
      const onAbort = () => {
        cleanup();
        reject(new Error('Discovery provider address lookup timed out.'));
      };
      if (controller.aborted) {
        onAbort();
        return;
      }
      controller.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve().then(() => (options.resolver ?? safeResolver)(hostname)).then(
        value => { cleanup(); resolve(value); },
        error => { cleanup(); reject(error); },
      );
    });
  }
  catch { throw new Error('Discovery provider could not be reached.'); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Discovery provider address is not public.');
  const address = addresses.find(item => item.family === 4) ?? addresses[0];
  let response: Response;
  try { response = await (options.transport ?? pinnedTransport)(url, address, controller); }
  catch { throw new Error('Discovery provider could not be reached.'); }
  try {
    options.onHttpStatus?.(response.status);
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new DiscoverySourceFetchError('malformed', 'Discovery provider redirected unexpectedly.', response.status);
    const data = await readJson(response);
    const rows: unknown = source.provider === 'lever' ? data : asRecord(data).jobs;
    if (!Array.isArray(rows)) throw new Error('Discovery provider returned an incomplete board.');
    // A capped scan cannot safely be treated as complete: callers use a successful
    // return to decide which saved jobs may now be marked closed.
    if (rows.length > MAX_JOBS) throw new Error('Discovery board exceeds the complete scan limit.');
    const normalized: PublicDiscoveryJob[] = [];
    for (const row of rows) {
      // Ashby includes unlisted records in some board payloads; they are not
      // active postings and are the one intentional row-level omission.
      if (source.provider === 'ashby' && asRecord(row).isListed === false) continue;
      const job = normalize(source, row);
      if (!job) throw new Error('Discovery provider returned an incomplete board.');
      normalized.push(job);
    }
    options.onRowCounts?.(rows.length, normalized.length);
    return normalized;
  } finally {
    await response.body?.cancel().catch(() => undefined);
    const close = (response as Response & { _discoveryClose?: () => Promise<void> })._discoveryClose;
    if (close) await close();
  }
}
