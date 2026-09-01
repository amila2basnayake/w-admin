/**
 * Fake PBX portal for dev/tests — behaves like the hosted PBX's web UI as the CRM (ContactBo.
 * getPhoneCall) and src/call-notes/pbx.ts drive it:
 *   GET  /                              primes an (unauthenticated) session cookie + login page
 *   POST /                              form input_user/input_pass/submit_login
 *        ONLY authenticates when it carries a cookie a prior GET issued (session-fixation defence,
 *        exactly like the real Elastix portal); the session id is ROTATED on success. A lone
 *        cookie-less POST still 302s but hands out an UNauthenticated session -> its download gets
 *        the login page. This is the production bug the two-stage login in pbx.ts fixes.
 *   GET  /?menu=monitoring&action=download&id=<callId>
 *        with an authenticated cookie: 200 audio/wav from <dir>/<callId>.wav (or .mp3), 404 if absent
 *        ids starting with "pending-": 404 for the first N hits, then served (portal lag)
 *        ids starting with "chunked-": served WITHOUT Content-Length (chunked transfer) in pieces
 *        without an authenticated cookie: 200 text/html login page (that is what the real portal does)
 *
 * Usage:  tsx test/fake-pbx.ts [--port 7866] [--dir test/fixtures/calls] [--pending-hits 2]
 * or import { startFakePbx } from tests.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FakePbxOptions {
  port?: number;
  dir: string;
  user?: string;
  password?: string;
  /** How many times a "pending-*" id answers 404 before it is served. */
  pendingHits?: number;
  /** Optional in-memory files (id -> bytes) that win over the directory. */
  files?: Map<string, Buffer>;
}

export interface FakePbx { url: string; port: number; hits: string[]; close: () => Promise<void>; }

const LOGIN_PAGE = '<!DOCTYPE html><html><head><title>PBX login</title></head><body><form method="post"><input name="input_user"/><input name="input_pass"/><input type="submit" name="submit_login" value="Submit"/></form></body></html>';

export function startFakePbx(opts: FakePbxOptions): Promise<FakePbx> {
  const user = opts.user ?? 'wfsupport', password = opts.password ?? 'secret';
  const issued = new Set<string>();   // sessions handed out by a GET, not yet authenticated
  const authedSessions = new Set<string>();   // sessions a primed login POST has authenticated
  const pendingSeen = new Map<string, number>();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    const sidOf = (): string | undefined => { const m = /PBXSESS=([a-f0-9]+)/.exec(req.headers.cookie || ''); return m ? m[1] : undefined; };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const credsOk = p.get('input_user') === user && p.get('input_pass') === password;
        const sid = sidOf();
        if (credsOk && sid && issued.has(sid)) {
          // Session-fixation defence: only a POST carrying a cookie a prior GET issued is authenticated,
          // and the session id is ROTATED on success.
          issued.delete(sid);
          const nsid = randomBytes(8).toString('hex');
          authedSessions.add(nsid);
          res.writeHead(302, { Location: '/?menu=home', 'Set-Cookie': `PBXSESS=${nsid}; Path=/; HttpOnly` });
          res.end();
        } else if (credsOk) {
          // Valid creds but no primed cookie (a lone first-request POST): the real portal still answers
          // 302 and hands out a FRESH, unauthenticated session -> a later download then gets the login page.
          const nsid = randomBytes(8).toString('hex');
          issued.add(nsid);
          res.writeHead(302, { Location: '/?menu=login', 'Set-Cookie': `PBXSESS=${nsid}; Path=/; HttpOnly` });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(LOGIN_PAGE);
        }
      });
      return;
    }
    const sid = sidOf();
    const isAuthed = !!(sid && authedSessions.has(sid));
    if (url.searchParams.get('menu') === 'monitoring' && url.searchParams.get('action') === 'download') {
      const id = url.searchParams.get('id') || '';
      if (!isAuthed) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(LOGIN_PAGE); return; }
      if (id.startsWith('pending-')) {
        const n = (pendingSeen.get(id) ?? 0) + 1;
        pendingSeen.set(id, n);
        if (n <= (opts.pendingHits ?? 2)) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<html><body>Not found</body></html>'); return; }
      }
      const chunked = id.startsWith('chunked-');
      const key = id.replace(/^pending-/, '').replace(/^chunked-/, '');
      let bytes: Buffer | null = opts.files?.get(key) ?? null;
      let ct = 'audio/wav';
      if (!bytes) {
        for (const ext of ['wav', 'mp3']) {
          const p = join(opts.dir, `${key}.${ext}`);
          if (existsSync(p)) { bytes = readFileSync(p); ct = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'; break; }
        }
      }
      if (!bytes) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<html><body>Not found</body></html>'); return; }
      if (chunked) {
        // No Content-Length: the client cannot know the size until it has read it all.
        res.writeHead(200, { 'Content-Type': ct, 'Content-Disposition': `attachment; filename="${key}.wav"` });
        const step = 64 * 1024;
        let off = 0;
        const pump = () => {
          if (off >= bytes!.length) { res.end(); return; }
          const ok = res.write(bytes!.subarray(off, Math.min(bytes!.length, off + step)));
          off += step;
          if (ok) setImmediate(pump); else res.once('drain', pump);
        };
        pump();
        return;
      }
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${key}.wav"` });
      res.end(bytes);
      return;
    }
    // Any other page (e.g. the login page GET that primes the handshake): a request with no session
    // is issued an unauthenticated one; an authenticated session sees the home page.
    if (!sid) {
      const nsid = randomBytes(8).toString('hex');
      issued.add(nsid);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `PBXSESS=${nsid}; Path=/; HttpOnly` });
      res.end(LOGIN_PAGE);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(isAuthed ? '<html><body>PBX home</body></html>' : LOGIN_PAGE);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}/`, port: addr.port, hits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// CLI
const isMain = process.argv[1] && /fake-pbx\.ts$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
  const port = Number(arg('--port', '7866'));
  const dir = arg('--dir', join(process.cwd(), 'test', 'fixtures', 'calls'));
  const pendingHits = Number(arg('--pending-hits', '2'));
  startFakePbx({ port, dir, pendingHits, user: process.env.FAKE_PBX_USER || 'wfsupport', password: process.env.FAKE_PBX_PASSWORD || 'secret' })
    .then((s) => console.log(`fake PBX on ${s.url} serving ${dir}  (user=wfsupport)`))
    .catch((e) => { console.error(e); process.exit(1); });
}
