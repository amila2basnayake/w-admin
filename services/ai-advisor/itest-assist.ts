// Live-server smoke for /assist (sidecar must be running on :3100 with the new code).
//   npx tsx itest-assist.ts
import crypto from 'node:crypto';
import { config } from './src/config';

const BASE = 'http://localhost:3100';
const STAFF_UID = 10, CLIENT_UID = 2725534, CLIENT_NAME = 'Beth';
function b64url(b: Buffer) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function mint(claims: Record<string, unknown>) {
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', config.sharedSecret).update(body).digest());
  return `${body}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
const staffAssist = mint({ uid: STAFF_UID, name: 'Admin Test', ut: 3, iat: now, exp: now + 900, nonce: 'a', act: CLIENT_UID, actName: CLIENT_NAME });
const clientPlain = mint({ uid: CLIENT_UID, name: 'Beth', ut: 0, iat: now, exp: now + 900, nonce: 'b' });
const clientForged = mint({ uid: CLIENT_UID, name: 'Beth', ut: 3, iat: now, exp: now + 900, nonce: 'c', act: 119063, actName: 'Stuart' });

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${n}${d ? '  (' + d + ')' : ''}`); c ? pass++ : fail++; };
const call = (tok: string, method: string, path: string, body?: unknown) =>
  fetch(BASE + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

// 1. /assist/me with a proper staff+act token
let r = await call(staffAssist, 'GET', '/assist/me');
const me = await r.json();
ok('staff assist token -> /assist/me 200', r.status === 200 && me.clientUid === CLIENT_UID && me.clientName === CLIENT_NAME, JSON.stringify(me));

// 2. plain client token (no act) -> 403
r = await call(clientPlain, 'GET', '/assist/me');
ok('client token without act -> 403', r.status === 403, String(r.status));

// 3. act claim but caller is NOT staff (forged ut is ignored; DB usertype decides) -> 403
r = await call(clientForged, 'GET', '/assist/me');
ok('act token from non-staff uid -> 403 (DB usertype is the authority)', r.status === 403, String(r.status));

// 4. conversation CRUD
r = await call(staffAssist, 'POST', '/assist/conversations', {});
const conv = await r.json();
ok('create assist conversation', r.status === 200 && conv.id > 0 && conv.mine === true, 'id ' + conv.id);

// 5. real chat turn (SSE) — grounded on the client, third-person register
r = await call(staffAssist, 'POST', `/assist/conversations/${conv.id}/chat`, { message: "What water does this client actually hold, and in which zones? Keep it brief." });
ok('chat turn returns SSE stream', r.status === 200 && (r.headers.get('content-type') || '').includes('text/event-stream'), String(r.status));
let text = '', tools: string[] = [], sawDone = false, errMsg = '';
if (r.status === 200 && r.body) {
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const dl = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dl) continue;
      try {
        const evt = JSON.parse(dl.slice(6));
        if (evt.type === 'delta') text += evt.text;
        else if (evt.type === 'tool') tools.push(evt.name);
        else if (evt.type === 'done') { sawDone = true; text = evt.text || text; }
        else if (evt.type === 'error') errMsg = evt.message;
      } catch {}
    }
  }
}
ok('turn completed (done event)', sawDone, errMsg || `${text.length} chars`);
ok('grounding tools were used', tools.some((t) => /mcp__wf__/.test(t)), tools.slice(0, 6).join(','));
ok('no trading-action tool invoked', !tools.some((t) => /prepare_|escalate|cancel_escalation/.test(t)));
console.log('\n--- reply ---\n' + text.slice(0, 1200) + '\n-------------');

// 6. messages listed; history visible; cleanup
r = await call(staffAssist, 'GET', `/assist/conversations/${conv.id}/messages`);
const msgs = await r.json();
ok('messages persisted (user+assistant)', Array.isArray(msgs) && msgs.length >= 2, String(msgs.length));
r = await call(staffAssist, 'GET', '/assist/conversations');
const list = await r.json();
ok('conversation in per-client history with staff attribution', list.some((c: any) => c.id === conv.id && c.staff_name === 'Admin Test'));
r = await call(staffAssist, 'DELETE', `/assist/conversations/${conv.id}`);
ok('cleanup delete', r.status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
