// Live-server smoke for speech on every surface (sidecar must be running on :3100 with the new code):
// the capability flags on each surface's /me, read-aloud over each surface's own TTS route, and the
// admission rules (a client token cannot use the staff routes; the staff routes ignore the client
// kill switch). Needs the OpenAI key for the audio checks.
//   npx tsx itest-speech.ts
import crypto from 'node:crypto';
import { config } from './src/config';

const BASE = process.env.AIADVISOR_ITEST_BASE || 'http://localhost:3100';
const STAFF_UID = 10, CLIENT_UID = 2725534, CLIENT_NAME = 'Beth', STUART_UID = 119063;
function b64url(b: Buffer) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function mint(claims: Record<string, unknown>) {
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', config.sharedSecret).update(body).digest());
  return `${body}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
const staffAssist = mint({ uid: STAFF_UID, name: 'Admin Test', ut: 3, iat: now, exp: now + 900, nonce: 'a', act: CLIENT_UID, actName: CLIENT_NAME });
const staffPlain = mint({ uid: STAFF_UID, name: 'Admin Test', ut: 3, iat: now, exp: now + 900, nonce: 's' });
const clientPlain = mint({ uid: STUART_UID, name: 'Stuart', ut: 0, iat: now, exp: now + 900, nonce: 'b' });

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${n}${d ? '  (' + d + ')' : ''}`); c ? pass++ : fail++; };
const call = (tok: string, method: string, path: string, body?: unknown) =>
  fetch(BASE + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const health = await (await fetch(BASE + '/health')).json();
ok('health reports the speech configuration', !!health.speech && typeof health.speech.tts?.provider === 'string', JSON.stringify(health.speech));
const ttsOn = !!health.speech?.tts?.enabled;

// ---- capability flags on every surface's /me ---------------------------------
for (const [label, tok, path] of [['client /me', clientPlain, '/me'], ['rail /assist/me', staffAssist, '/assist/me'], ['trainer /trainer/me', staffPlain, '/trainer/me']] as const) {
  const r = await call(tok, 'GET', path);
  const j = await r.json().catch(() => ({}));
  ok(`${label} carries transcribe + tts flags`, r.status === 200 && typeof j.transcribe === 'boolean' && typeof j.tts === 'boolean' && j.tts === ttsOn, `${r.status} transcribe=${j.transcribe} tts=${j.tts}`);
  ok(`${label} names the reader in effect`, j.reader === health.speech?.reader?.mode && (j.reader === 'retell' || j.reader === 'openai'), `reader=${j.reader}`);
}

// ---- read-aloud over each surface's own route --------------------------------
const TEXT = 'Bids sit at **$95/ML** this week.\n\n| Zone | Price |\n|---|---|\n| 1A | 95 |';
for (const [label, tok, path] of [['client /tts', clientPlain, '/tts'], ['rail /assist/tts', staffAssist, '/assist/tts'], ['trainer /trainer/tts', staffPlain, '/trainer/tts']] as const) {
  const r = await call(tok, 'POST', path, { text: TEXT });
  if (ttsOn) {
    const buf = Buffer.from(await r.arrayBuffer());
    const mp3 = buf.length > 1000 && (buf.slice(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));
    ok(`${label} -> audio/mpeg bytes`, r.status === 200 && /audio\/mpeg/.test(r.headers.get('content-type') || '') && mp3, `${r.status} ${buf.length} bytes`);
  } else {
    ok(`${label} -> 503 when unconfigured`, r.status === 503, String(r.status));
  }
  const e = await call(tok, 'POST', path, { text: '---' });
  ok(`${label} nothing-to-speak -> 400`, e.status === 400, String(e.status));
}

// ---- admission ---------------------------------------------------------------
let r = await call(clientPlain, 'POST', '/assist/tts', { text: 'hello' });
ok('client token -> /assist/tts 403 (not an assist token)', r.status === 403, String(r.status));
r = await call(clientPlain, 'POST', '/trainer/tts', { text: 'hello' });
ok('client token -> /trainer/tts refused', r.status === 403 || r.status === 404, String(r.status));
r = await call(staffPlain, 'POST', '/assist/tts', { text: 'hello' });
ok('staff token without act -> /assist/tts 403', r.status === 403, String(r.status));
r = await call('not.a.token', 'POST', '/tts', { text: 'hello' });
ok('garbage token -> /tts 401', r.status === 401, String(r.status));

console.log(`\nspeech itest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
