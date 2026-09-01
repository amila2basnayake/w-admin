// Standalone AI Water Advisor page — serves the REAL advisor UI (crm-seam/ai-advisor.js/.css)
// without the legacy CRM. It reproduces the JSP's bootstrap (window.WFAI + #wfai-root) and mints/
// refreshes the same HMAC token the JSP mints, so it talks straight to the sidecar on :3100.
//
//   node standalone/serve.mjs        # from services/ai-advisor
//
// Env (all optional): STANDALONE_PORT=8080  STANDALONE_SIDECAR=http://localhost:3100
//                     STANDALONE_UID=119063 STANDALONE_NAME="Stuart Hodge" STANDALONE_UT=0
// NOTE: add the page origin (http://localhost:8080) to the sidecar's CORS_ORIGINS so the browser
//       fetch to :3100 is allowed.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const seam = join(here, '..', 'crm-seam');

function envVal(key) {
  if (process.env[key]) return process.env[key];
  try {
    const s = readFileSync(join(here, '..', '.env'), 'utf8');
    const m = s.match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

const SECRET = envVal('AIADVISOR_SHARED_SECRET');
if (!SECRET) { console.error('FATAL: no AIADVISOR_SHARED_SECRET in ../.env'); process.exit(1); }

const PORT    = Number(process.env.STANDALONE_PORT || 8080);
// Loopback by default — this page mints real advisor tokens, so exposing it on the
// LAN (STANDALONE_HOST=0.0.0.0) authenticates any device as the configured uid.
const HOST    = process.env.STANDALONE_HOST || '127.0.0.1';
const SIDECAR = (process.env.STANDALONE_SIDECAR || 'http://localhost:3100').replace(/\/$/, '');
const UID     = Number(process.env.STANDALONE_UID || 119063);
const NAME    = process.env.STANDALONE_NAME || 'Stuart Hodge';
const UT      = Number(process.env.STANDALONE_UT || 0);
const TTL     = Number(process.env.STANDALONE_TTL || 1800);

const b64url = (b) => Buffer.from(b).toString('base64url');
function mint() {
  const now = Math.floor(Date.now() / 1000);
  const claims = { uid: UID, name: NAME, ut: UT, iat: now, exp: now + TTL, nonce: crypto.randomBytes(8).toString('hex') };
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
  return { token: body + '.' + sig, exp: now + TTL };
}

const JS  = readFileSync(join(seam, 'ai-advisor.js'), 'utf8');
const CSS = readFileSync(join(seam, 'ai-advisor.css'), 'utf8');
const CUR_JS  = readFileSync(join(seam, 'ai-curator.js'), 'utf8');
const CUR_CSS = readFileSync(join(seam, 'ai-curator.css'), 'utf8');

function shell() {
  const t = mint();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Water Advisor (standalone)</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">
<link rel="stylesheet" href="/ai-advisor.css"></head><body>
<div id="wfai-root"></div>
<script>window.WFAI={token:${JSON.stringify(t.token)},baseUrl:${JSON.stringify(SIDECAR)},userId:${UID},userName:${JSON.stringify(NAME)},tokenTtl:${TTL},refreshUrl:"/token"};</script>
<script src="/ai-advisor.js"></script></body></html>`;
}

// AI Trainer page at /trainer (also /curator) — same minted token; the sidecar admits staff accounts only, so set
// STANDALONE_UID to a waterfind_user whose usertype is broker/sales/admin (1/2/3).
function curatorShell() {
  const t = mint();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Trainer (standalone)</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">
<link rel="stylesheet" href="/ai-curator.css"></head><body>
<div id="wfc-root"></div>
<script>window.WFCUR={token:${JSON.stringify(t.token)},baseUrl:${JSON.stringify(SIDECAR)},userId:${UID},userName:${JSON.stringify(NAME)},tokenTtl:${TTL},refreshUrl:"/token"};</script>
<script src="/ai-curator.js"></script></body></html>`;
}

const send = (res, code, type, body, extra = {}) =>
  { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') send(res, 200, 'text/html; charset=UTF-8', shell());
  else if (url === '/trainer' || url === '/curator') send(res, 200, 'text/html; charset=UTF-8', curatorShell());
  else if (url === '/token')          send(res, 200, 'application/json; charset=UTF-8', JSON.stringify(mint()));
  else if (url === '/ai-advisor.js')  send(res, 200, 'application/javascript; charset=UTF-8', JS);
  else if (url === '/ai-advisor.css') send(res, 200, 'text/css; charset=UTF-8', CSS);
  else if (url === '/ai-curator.js')  send(res, 200, 'application/javascript; charset=UTF-8', CUR_JS);
  else if (url === '/ai-curator.css') send(res, 200, 'text/css; charset=UTF-8', CUR_CSS);
  else send(res, 404, 'text/plain', 'not found');
}).listen(PORT, HOST, () => {
  console.log(`standalone advisor page: http://${HOST}:${PORT}  (trainer at /trainer; user ${NAME}/${UID} ut=${UT}, sidecar ${SIDECAR})`);
});
