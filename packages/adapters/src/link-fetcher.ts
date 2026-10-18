import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch, type Response } from 'undici';
export { extractJobText } from './job-text';

export class LinkFetchError extends Error {
  constructor(public code: 'UNSAFE_URL' | 'NEEDS_PASTE', message: string) { super(message); }
}
type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
type Transport = (url: URL, address: Address, signal: AbortSignal) => Promise<{ response: Response; close: () => Promise<void> }>;
const MAX_BYTES = 2 * 1024 * 1024;
const unsafe = () => new LinkFetchError('UNSAFE_URL', 'This address cannot be fetched. Paste the role description instead.');
const fallback = () => new LinkFetchError('NEEDS_PASTE', 'This page could not be read. Paste the role description instead.');
export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}
export async function resolvePublicUrl(input: string | URL, resolver: Resolver = hostname => dnsLookup(hostname, { all: true, verbatim: true })) {
  let url: URL;
  try { url = new URL(input); } catch { throw unsafe(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw unsafe();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Address[];
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try { addresses = await resolver(hostname); } catch { throw fallback(); }
  }
  if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) throw unsafe();
  return { url, address: addresses.find(address => address.family === 4) ?? addresses[0] };
}
const pinnedTransport: Transport = async (url, address, signal) => {
  const agent = new Agent({
    autoSelectFamily: false,
    connect: { lookup: (_hostname, _options, callback) => callback(null, address.address, address.family) },
  });
  try {
    const response = await fetch(url, { dispatcher: agent, redirect: 'manual', signal, headers: { Accept: 'text/html,text/plain;q=0.9', 'User-Agent': 'CareerWorkspace/0.1' } });
    return { response, close: () => agent.close() };
  } catch (error) { await agent.destroy(); throw error; }
};
async function readLimited(response: Response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw fallback(); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BYTES) throw fallback();
      chunks.push(result.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
/** DNS is checked once per hop; the connection uses that exact checked IP. */
export async function fetchJobPage(input: string, options: { resolve?: Resolver; transport?: Transport; timeoutMs?: number } = {}) {
  const signal = AbortSignal.timeout(Math.min(10_000, Math.max(1, options.timeoutMs ?? 10_000)));
  let current = input;
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const resolved = await abortable(resolvePublicUrl(current, options.resolve), signal);
      const { response, close } = await (options.transport ?? pinnedTransport)(resolved.url, resolved.address, signal);
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirects === 3) throw fallback();
          current = new URL(location, resolved.url).toString();
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw fallback(); }
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType && !/^text\/(html|plain)\b/i.test(contentType)) { await response.body?.cancel(); throw fallback(); }
        return { url: resolved.url.toString(), contentType, text: await readLimited(response) };
      } finally { await close(); }
    }
    throw fallback();
  } catch (error) {
    if (error instanceof LinkFetchError) throw error;
    throw fallback();
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
