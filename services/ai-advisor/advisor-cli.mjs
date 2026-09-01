// Headless driver for eval persona agents: one advisor turn per invocation.
//   node advisor-cli.mjs turn --uid 119063 --name "Stuart Hodge" --conv new --message-file q.txt
//   node advisor-cli.mjs turn --uid 119063 --name "Stuart Hodge" --conv 42 --message-file f.txt
// Prints JSON: { conv, tools: [...], text, error }
// Mints a fresh token per call (same HMAC as src/scripts/mint-token.ts). Never touches /orders.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://localhost:3100';

function env() {
  const txt = readFileSync(join(HERE, '.env'), 'utf8');
  const m = {};
  for (const line of txt.split(/\r?\n/)) {
    const mm = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (mm) m[mm[1]] = mm[2];
  }
  return m;
}

function mint(uid, name) {
  const secret = env().AIADVISOR_SHARED_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const claims = { uid: Number(uid), name, ut: 2, iat: now, exp: now + 1800, nonce: crypto.randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== 'turn') { console.error('usage: advisor-cli.mjs turn --uid U --name N --conv new|ID --message-file F'); process.exit(2); }
  const uid = arg('uid'); const name = arg('name'); let conv = arg('conv', 'new');
  const message = readFileSync(arg('message-file'), 'utf8').trim();
  const token = mint(uid, name);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  if (conv === 'new') {
    const r = await fetch(`${BASE}/conversations`, { method: 'POST', headers: H, body: '{}' });
    if (!r.ok) { console.log(JSON.stringify({ error: `create conv HTTP ${r.status}: ${await r.text()}` })); process.exit(1); }
    conv = String((await r.json()).id);
  }

  const resp = await fetch(`${BASE}/conversations/${conv}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ message }) });
  if (!resp.ok) { console.log(JSON.stringify({ conv, error: `chat HTTP ${resp.status}: ${await resp.text()}` })); process.exit(1); }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', error = null;
  const tools = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'tool') tools.push(ev.name);
      else if (ev.type === 'delta') text += ev.text;
      else if (ev.type === 'done') text = ev.text || text;
      else if (ev.type === 'error') error = ev.message;
    }
  }
  console.log(JSON.stringify({ conv: Number(conv), tools, text, error }));
}
main().catch((e) => { console.log(JSON.stringify({ error: String(e) })); process.exit(1); });
