/**
 * Recording source: the hosted PBX's web portal, fetched exactly the way the CRM itself does it
 * (ContactBo.getPhoneCall): form-POST the login (input_user / input_pass / submit_login), expect a
 * 302 with a session cookie, then GET `<base>?menu=monitoring&action=download&id=<phonecall_id>`.
 * Credentials come from the CRM's own phone_system_settings row (pbx_server_*), or from env for
 * dev/test against the fake PBX (test/fake-pbx.ts). Nothing here is cached: a call's recording is
 * fetched once per note and the bytes are never written to disk.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { query } from '../db';
import { callNotesConfig as C } from './config';
import { sniffAudio } from './wav';

export interface PbxSettings { baseUrl: string; user: string; password: string; }

export type PbxFetchResult =
  | { ok: true; audio: Buffer; contentType: string; ext: string }
  | { ok: false; reason: 'not_configured' | 'auth' | 'not_found' | 'unavailable' | 'too_large'; message: string };

let settingsCache: { at: number; value: PbxSettings | null } | null = null;

/**
 * URL hygiene for the portal base. It is a URL the sidecar will POST credentials to and then
 * GET from, so: http(s) only, and when it comes out of the CRM's settings row (a DB value anyone
 * with CRM admin can edit) never the sidecar's own loopback / link-local / cloud-metadata
 * addresses — that would turn the recording fetch into an SSRF primitive against the host.
 * Private LAN ranges ARE allowed (the PBX normally lives on one). The `env` source (dev/test
 * against the fake PBX on 127.0.0.1) may use loopback.
 */
export function validatePbxBaseUrl(raw: string, source: 'db' | 'env'): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, reason: 'not a URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} not allowed` };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL not allowed' };
  if (source === 'db') {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const bad =
      host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1'
      || /^127\./.test(host)                                   // loopback
      || /^169\.254\./.test(host)                              // link-local / cloud metadata (169.254.169.254)
      || /^fe[89ab][0-9a-f]:/i.test(host)                      // IPv6 link-local
      || /^::ffff:(127\.|169\.254\.)/i.test(host)              // v4-mapped
      || host === 'metadata.google.internal' || host === 'metadata' || host.endsWith('.internal');
    if (bad) return { ok: false, reason: `host ${host} not allowed for a PBX` };
  }
  return { ok: true, url: u };
}

/** `<base>?menu=monitoring&action=download&id=<id>` built properly whether or not the base already has a query. */
export function pbxDownloadUrl(base: URL, id: string): string {
  const u = new URL(base.toString());
  u.searchParams.set('menu', 'monitoring');
  u.searchParams.set('action', 'download');
  u.searchParams.set('id', id);
  return u.toString();
}

/** Resolve where recordings live. `null` = recordings are off (dictation/upload still work). */
export async function pbxSettings(): Promise<PbxSettings | null> {
  if (C.pbxSource === 'off') return null;
  if (C.pbxSource === 'env') {
    if (!C.pbxBaseUrl) return null;
    const v = validatePbxBaseUrl(C.pbxBaseUrl, 'env');
    if (!v.ok) { console.warn(`[call-notes] AIADVISOR_PBX_BASE_URL rejected: ${v.reason}`); return null; }
    return { baseUrl: C.pbxBaseUrl, user: C.pbxUser, password: C.pbxPassword };
  }
  // 'db': the CRM's settings row. Cached briefly — it changes once a decade.
  if (settingsCache && Date.now() - settingsCache.at < 60_000) return settingsCache.value;
  let value: PbxSettings | null = null;
  try {
    const r = await query(
      `SELECT pbx_server_ip_address AS base, pbx_server_username AS usr, pbx_server_password AS pwd,
              phone_system_enabled AS enabled
         FROM public.phone_system_settings
        ORDER BY (name = 'default') DESC, id ASC LIMIT 1`,
    );
    const row = r.rows[0];
    // The CRM's own master switch for its phone integration is honoured too.
    if (row && row.enabled === false) { settingsCache = { at: Date.now(), value: null }; return null; }
    if (row && row.base && String(row.base).trim()) {
      const v = validatePbxBaseUrl(String(row.base), 'db');
      if (v.ok) value = { baseUrl: String(row.base).trim(), user: String(row.usr ?? ''), password: String(row.pwd ?? '') };
      else console.warn(`[call-notes] phone_system_settings.pbx_server_ip_address rejected: ${v.reason}`);
    }
  } catch (e: any) {
    console.warn('[call-notes] phone_system_settings lookup failed:', e?.message ?? e);
    value = null;
  }
  settingsCache = { at: Date.now(), value };
  return value;
}
export function _resetPbxSettingsCache(): void { settingsCache = null; }

/**
 * All portal traffic goes through here so C.pbxProxy covers every PBX request and nothing else.
 * The proxied path must use undici's own fetch: handing an installed-undici ProxyAgent to Node's
 * bundled-undici global fetch mixes two undici copies (the dispatcher is matched by internal
 * symbols, not interface). Casts are that same one-copy-vs-the-other mismatch, at the type level.
 */
let pbxDispatcher: ProxyAgent | null | undefined;
function pbxFetch(url: string, init: RequestInit): Promise<Response> {
  if (pbxDispatcher === undefined) pbxDispatcher = C.pbxProxy ? new ProxyAgent(C.pbxProxy) : null;
  if (!pbxDispatcher) return fetch(url, init);
  return undiciFetch(url, { ...(init as any), dispatcher: pbxDispatcher }) as unknown as Promise<Response>;
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

/** Set-Cookie(s) from a response as name->value pairs (first value each; undici exposes getSetCookie
 *  on Node 20+, else the folded single header). */
function setCookiePairs(res: Response): Array<[string, string]> {
  const anyHeaders = res.headers as any;
  const list: string[] = typeof anyHeaders.getSetCookie === 'function'
    ? anyHeaders.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
  const out: Array<[string, string]> = [];
  for (const c of list) {
    const nv = c.split(';')[0].trim();
    const i = nv.indexOf('=');
    if (i > 0) out.push([nv.slice(0, i).trim(), nv.slice(i + 1).trim()]);
  }
  return out;
}
/** Accumulate cookies across the login handshake; a later value wins, so a rotated session id (the
 *  portal regenerates it on successful login — session-fixation defence) replaces the primed one. */
function mergeCookies(jar: Map<string, string>, res: Response): void {
  for (const [k, v] of setCookiePairs(res)) jar.set(k, v);
}
function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
}

/** Read a response body up to `cap` bytes; null (and the stream cancelled) once it passes the cap. */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(parts, total);
}

function looksLikeHtml(buf: Buffer, contentType: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<script');
}

/** The portal answers HTTP 200 with its login page whenever the session is not authenticated (fixation
 *  guard, expired session, wrong creds). Recognise it so an auth break is reported as `auth`, not as a
 *  missing recording (which would hide the cause and, for a fresh call, drive pointless retries). */
function looksLikeLoginPage(buf: Buffer): boolean {
  const head = buf.subarray(0, 4096).toString('latin1').toLowerCase();
  return head.includes('name="input_pass"') || head.includes('name="input_user"')
    || head.includes('invalid login') || head.includes('login to access');
}

/**
 * Fetch one recording by the PBX call id. One attempt; the caller decides about retries
 * (a call that ended seconds ago may not have its file on the portal yet).
 */
export async function fetchRecordingOnce(phonecallId: string, settings?: PbxSettings | null): Promise<PbxFetchResult> {
  const s = settings === undefined ? await pbxSettings() : settings;
  if (!s) return { ok: false, reason: 'not_configured', message: 'no recording source configured' };
  const id = String(phonecallId || '').trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) return { ok: false, reason: 'not_found', message: 'bad call id' };
  // Explicit settings (tests, future callers) get the same hygiene as the resolved ones.
  const base = validatePbxBaseUrl(s.baseUrl, C.pbxSource === 'db' ? 'db' : 'env');
  if (!base.ok) return { ok: false, reason: 'not_configured', message: `PBX URL rejected: ${base.reason}` };

  // 1) authenticate. The Elastix portal uses session-fixation protection: it only authenticates a
  // login POST that already carries a session cookie IT issued. So prime the session with a GET,
  // then POST the credentials with that cookie; a successful login answers 302 and ROTATES the
  // session id, which we carry forward for the download. (A lone first-request POST — no prior GET,
  // which is what the CRM's own download link does — is never authenticated: the portal serves it
  // the login page, and the download then comes back as that same 200 HTML.)
  const jar = new Map<string, string>();

  const prime = withTimeout(C.pbxTimeoutMs);
  try {
    const res = await pbxFetch(base.url.toString(), { redirect: 'manual', signal: prime.signal });
    mergeCookies(jar, res);
    await res.arrayBuffer().catch(() => undefined);
  } catch (e: any) {
    return { ok: false, reason: 'unavailable', message: `PBX unreachable: ${e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e)}` };
  } finally { prime.done(); }

  const login = withTimeout(C.pbxTimeoutMs);
  try {
    const form = new URLSearchParams({ input_pass: s.password, input_user: s.user, submit_login: 'Submit' });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const primed = cookieHeader(jar);
    if (primed) headers.Cookie = primed;
    const res = await pbxFetch(base.url.toString(), {
      method: 'POST', headers, body: form.toString(), redirect: 'manual', signal: login.signal,
    });
    mergeCookies(jar, res);   // pick up the rotated (authenticated) session id
    // 302/303 (or a 200 landing page) means "proceed"; the download response is the real proof of
    // auth (a login page comes back as 200 HTML, handled below). Only a 4xx/5xx is a hard failure.
    if (res.status >= 400) {
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false, reason: 'auth', message: `PBX login answered ${res.status}` };
    }
    await res.arrayBuffer().catch(() => undefined);
  } catch (e: any) {
    return { ok: false, reason: 'unavailable', message: `PBX unreachable: ${e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e)}` };
  } finally { login.done(); }

  const cookie = cookieHeader(jar);

  // 2) download
  const dl = withTimeout(C.pbxTimeoutMs);
  try {
    const url = pbxDownloadUrl(base.url, id);
    const res = await pbxFetch(url, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual', signal: dl.signal });
    if (res.status === 404) return { ok: false, reason: 'not_found', message: 'recording not found on the PBX' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', message: `PBX refused the download (${res.status})` };
    if (res.status >= 300) return { ok: false, reason: 'not_found', message: `PBX answered ${res.status} for the download` };
    const len = Number(res.headers.get('content-length') || 0);
    if (len > C.maxRecordingBytes) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large', message: `recording is ${Math.round(len / 1048576)} MB` };
    }
    // Stream the body and stop the moment it passes the cap (a portal that omits Content-Length,
    // or lies, must not be able to make us buffer an unbounded response).
    const audio = await readCapped(res, C.maxRecordingBytes);
    if (!audio) return { ok: false, reason: 'too_large', message: `recording exceeds ${Math.round(C.maxRecordingBytes / 1048576)} MB` };
    const contentType = res.headers.get('content-type') || '';
    if (looksLikeLoginPage(audio)) {
      // Session was not authenticated (fixation guard / expired session / bad creds): the portal
      // serves its login page as a 200. Report it as `auth` — distinct from a missing recording — so
      // the cause is visible in logs and a fresh call is not retried pointlessly.
      return { ok: false, reason: 'auth', message: 'PBX served its login page (session not authenticated)' };
    }
    if (!audio.length || looksLikeHtml(audio, contentType)) {
      // Some other HTML/landing page, or an empty body: the recording is not retrievable for this id.
      return { ok: false, reason: 'not_found', message: 'PBX did not return an audio file for this call' };
    }
    const sniff = sniffAudio(audio);
    const ext = sniff?.ext ?? (/audio\/(x-)?wav/i.test(contentType) ? 'wav' : /mpeg|mp3/i.test(contentType) ? 'mp3' : 'wav');
    return { ok: true, audio, contentType: sniff?.mime ?? (contentType || 'audio/wav'), ext };
  } catch (e: any) {
    return { ok: false, reason: 'unavailable', message: `PBX download failed: ${e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e)}` };
  } finally { dl.done(); }
}

/**
 * Fetch with patience for a just-finished call: the PBX writes the file at hangup and the portal
 * can lag by seconds. `fresh` = the call ended within the last few minutes -> retry not_found.
 */
export async function fetchRecording(
  phonecallId: string,
  opts: { fresh: boolean; onAttempt?: (n: number, r: PbxFetchResult) => void; sleep?: (ms: number) => Promise<void> } = { fresh: false },
): Promise<PbxFetchResult> {
  const settings = await pbxSettings();
  const attempts = opts.fresh ? Math.max(1, C.fetchRetries) : 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: PbxFetchResult = { ok: false, reason: 'unavailable', message: 'no attempt made' };
  for (let n = 1; n <= attempts; n++) {
    last = await fetchRecordingOnce(phonecallId, settings);
    opts.onAttempt?.(n, last);
    if (last.ok) return last;
    if (last.reason !== 'not_found' && last.reason !== 'unavailable') return last;   // auth/config/too_large: retrying is pointless
    if (n < attempts) await sleep(C.fetchRetryDelayMs);
  }
  return last;
}
