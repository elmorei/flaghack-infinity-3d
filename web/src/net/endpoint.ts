/** Remote-host addresses are explicit, origin-only destinations. Invite secrets stay in fragments. */
import { hostCompatibilityError, parseHostInfo } from './client';
export { hostCompatibilityError } from './client';
import { INFO_PATH, WS_PATH } from './protocol';
import type { HostInfo } from './protocol';

export interface HostEndpoint {
  origin: string;
  infoUrl: string;
  socketUrl: string;
}
export interface PageAddress { protocol: string; origin: string }
export interface Invite { host: string | null; password: string | null }

/** UI capability hint, not a security boundary: the existing offline launcher enforces its own CSP. */
export function browserAllowsRemoteHosts(context = {
  protocol: typeof location === 'undefined' ? '' : location.protocol,
  userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
}): boolean {
  return (context.protocol === 'https:' || context.protocol === 'http:') && !/\bElectron\//i.test(context.userAgent);
}

/** Throw useful validation errors without echoing a pasted password or credentials. */
function absoluteUrl(raw: string): URL {
  if (!/^https?:\/\//i.test(raw) || /[\s\\]/.test(raw)) throw new Error('Use a complete HTTPS host address, such as https://your-host.example.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('That host address is not a valid URL.'); }
  if (url.username || url.password || raw.split('/')[2]?.includes('@')) throw new Error('Do not put account credentials in the host address. Use the Password field.');
  if (raw.split('#')[0].includes('?')) throw new Error('Host addresses and invites must not include query parameters.');
  return url;
}

export function normalizeHostEndpoint(raw: string, page: PageAddress): HostEndpoint {
  const url = absoluteUrl(raw.trim());
  if (raw.trim().includes('#')) throw new Error('Paste a host origin or a valid invite, without extra fragment parameters.');
  if (url.pathname !== '/') throw new Error('Use the host origin only, without a path such as /api/info or /ws.');
  if (url.protocol === 'http:') {
    if (page.protocol === 'https:') throw new Error('This secure page needs an HTTPS host. Use the host’s HTTPS tunnel URL, not an HTTP address (mixed content).');
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (!loopback && url.origin !== page.origin) throw new Error('Remote hosts require HTTPS. HTTP is only supported for local development or this page’s own host.');
  }
  return { origin: url.origin, infoUrl: `${url.origin}${INFO_PATH}`, socketUrl: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${WS_PATH}` };
}

/** Parse only documented keys, reject duplicates and invalid escaping instead of guessing. */
export function parseInviteFragment(hash: string): Invite | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  if (!params.has('host') && !params.has('pw')) return null;
  try { decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { throw new Error('This invite has invalid URL escaping. Ask the host for a new invite.'); }
  for (const key of params.keys()) {
    if ((key !== 'host' && key !== 'pw') || params.getAll(key).length !== 1) throw new Error('This invite contains unexpected or repeated parameters. Ask the host for a new invite.');
  }
  const host = params.get('host');
  if (host !== null && host.trim() === '') throw new Error('This invite is missing its host address.');
  return { host, password: params.get('pw') };
}

/** Pasted HTTPS host origin, new Pages invite, or existing same-origin #pw invite. No I/O. */
export function parseHostAddress(raw: string, page: PageAddress): { endpoint: HostEndpoint; password: string | null } {
  const url = absoluteUrl(raw.trim());
  if (!url.hash) return { endpoint: normalizeHostEndpoint(url.href, page), password: null };
  const invite = parseInviteFragment(url.hash);
  if (!invite) throw new Error('This is not a supported host invite. Paste the HTTPS host address instead.');
  // The wrapper URL is never contacted; only its explicitly named host is used after Join.
  url.hash = '';
  const endpoint = normalizeHostEndpoint(invite.host ?? url.href, page);
  return { endpoint, password: invite.password };
}

/** Remove invite secrets before boot does any work; invalid invites are scrubbed as well. */
export function takeLocationInvite(loc: { hash: string; pathname: string; search: string }, history: Pick<History, 'state' | 'replaceState'>): Invite & { error: string | null } {
  const hash = loc.hash;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (!params.has('host') && !params.has('pw')) return { host: null, password: null, error: null };
  history.replaceState(history.state, '', loc.pathname + loc.search);
  try { return { ...(parseInviteFragment(hash) ?? { host: null, password: null }), error: null }; }
  catch (error) { return { host: null, password: null, error: error instanceof Error ? error.message : 'This invite is invalid.' }; }
}

export interface HostProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Boot discovery may show an incompatible same-origin host, but Join must enforce it. */
  checkCompatibility?: boolean;
}

/** No passwords, reconnect tokens, cookies, referrers or redirects are sent by discovery. */
export async function probeHost(endpoint: HostEndpoint, options: HostProbeOptions = {}): Promise<HostInfo> {
  const abort = new AbortController();
  let timedOut = false;
  const cancel = () => abort.abort();
  if (options.signal?.aborted) abort.abort();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, options.timeoutMs ?? 8000);
  try {
    if (abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const response = await (options.fetch ?? fetch)(endpoint.infoUrl, {
      signal: abort.signal, cache: 'no-store', credentials: 'omit', mode: 'cors', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`The host answered HTTP ${response.status}. Check its HTTPS tunnel and allowed browser origin.`);
    let json: unknown;
    try { json = await response.json(); } catch { throw new Error('That address did not return FLAGHACK host information. Check the host’s HTTPS address.'); }
    const info = parseHostInfo(json);
    if (!info) throw new Error('That address is not a valid FLAGHACK host. Check the host’s HTTPS address.');
    if (options.checkCompatibility !== false) {
      const mismatch = hostCompatibilityError(info);
      if (mismatch) throw new Error(mismatch);
    }
    return info;
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (timedOut) throw new Error('The host did not answer in time. Check that it is running and its HTTPS tunnel is still open.');
    if (error instanceof TypeError) throw new Error('Could not reach the host. Check its address, HTTPS tunnel and network. The host must allow this page’s origin (CORS).');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
