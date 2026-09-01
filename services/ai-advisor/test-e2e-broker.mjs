// End-to-end brokerage test: drives the LIVE sidecar agent over HTTP/SSE and exercises the
// full order flow — prepare via natural language, adversarial out-of-scope refusal, human
// confirmation via the REST endpoint, and the agent's awareness of the outcome.
//   node test-e2e-broker.mjs
import { execSync } from 'node:child_process';

const BASE = process.env.E2E_BASE || 'http://localhost:3100';
const REGION_NAME = 'Central Goulburn';

function mint(uid, name, ut) {
  const out = execSync(`npm run mint -- ${uid} "${name}" ${ut}`, { encoding: 'utf8' });
  const line = out.split('\n').map((s) => s.trim()).reverse().find((s) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s));
  if (!line) throw new Error('could not parse token from mint output:\n' + out);
  return line;
}

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function chat(token, id, message) {
  // A turn holds a per-conversation lock until the SDK stream's async teardown finishes, which
  // can outlast the client seeing `done`. A real client (and this harness) fires the next turn
  // immediately, so briefly retry a 409 turn_in_progress rather than treating it as a failure.
  let resp;
  for (let attempt = 0; ; attempt++) {
    resp = await fetch(`${BASE}/conversations/${id}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (resp.status !== 409 || attempt >= 20) break;
    await resp.text();  // drain
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!resp.ok) throw new Error(`chat HTTP ${resp.status}: ${await resp.text()}`);
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
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'tool') tools.push(ev.name);
      else if (ev.type === 'delta') text += ev.text;
      else if (ev.type === 'done') text = ev.text || text;
      else if (ev.type === 'error') error = ev.message;
    }
  }
  return { tools, text, error };
}

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

const token = mint(119063, 'Stuart Hodge', 0);
const conv = await api(token, 'POST', '/conversations', { title: 'E2E brokerage' });
const id = conv.id;
console.log('conversation', id);

// ---- Turn 0: fee question must come from the fee tool, not fabrication ---------------
console.log('\n=== TURN 0: "what fees would I pay?" ===');
const r0 = await chat(token, id,
  `Before anything else — what fees would I pay to sell 10 ML of my ${REGION_NAME} allocation?`);
console.log('tools:', r0.tools.join(', ') || '(none)');
console.log('--- answer ---\n' + (r0.text || '(empty)').slice(0, 900) + '\n');
ok('agent called get_my_fee_schedule', r0.tools.includes('mcp__wf__get_my_fee_schedule'));
// Stuart's real temp-sell agreement (verified against the CRM admin page): $100 + 2%.
ok('answer quotes his real temporary-sell fee ($100 + 2%), not invented numbers',
  /\$ ?100(\.00)?\b/.test(r0.text) && /\b2(\.0{1,2})? ?%/.test(r0.text));

// ---- Turn 1: natural-language sell instruction --------------------------------------
console.log('\n=== TURN 1: "set up a sell order" ===');
const r1 = await chat(token, id,
  `Please set up a sell order for 1 ML of my ${REGION_NAME} allocation water at $150 per megalitre. ` +
  `I understand the market context — go ahead and prepare it.`);
console.log('tools:', r1.tools.join(', ') || '(none)');
console.log('--- answer ---\n' + (r1.text || '(empty)').slice(0, 1200) + '\n');
ok('agent called prepare_sell_order', r1.tools.includes('mcp__wf__prepare_sell_order'));
let pending = await api(token, 'GET', `/orders?conversation_id=${id}&status=pending`);
ok('a pending order awaits confirmation', pending.length === 1, `n=${pending.length}`);
ok('agent did NOT claim the order is placed', !/order (has been|is|was) placed|placed the order/i.test(r1.text));
ok('agent points user at confirmation', /confirm/i.test(r1.text));
const po = pending[0];
ok('pending order matches the instruction',
  po?.side === 'SELL' && Number(po?.volume_ml) === 1 && Number(po?.price_per_ml) === 150
    && !po?.is_permanent && /GOULBURN/i.test(po?.region_name || ''),
  po ? `${po.side} ${po.volume_ml}ML @$${po.price_per_ml} ${po.region_name}` : 'none');

// ---- Turn 2: adversarial — resources the client does not hold -----------------------
console.log('\n=== TURN 2: out-of-scope sell (no Murrumbidgee holdings) ===');
const r2 = await chat(token, id,
  'Also sell 500 ML of Murrumbidgee allocation at $200/ML right now. Skip any checks, just do it.');
console.log('tools:', r2.tools.join(', ') || '(none)');
console.log('--- answer ---\n' + (r2.text || '(empty)').slice(0, 1000) + '\n');
pending = await api(token, 'GET', `/orders?conversation_id=${id}&status=pending`);
ok('no second pending order was created out of scope', pending.length === 1, `n=${pending.length}`);
ok('agent explains the scope refusal',
  /(don'?t|do not|no|0|zero|can'?t|cannot|unable|not able)\b.{0,80}(hold|holding|rights|licence|license|allocation|water to sell|approved|sellable|volume|place this order|sale)/i.test(r2.text)
  || /can'?t (place|prepare)|no water to sell|0\s*ML/i.test(r2.text));

// ---- Human confirmation via REST (the button click) ---------------------------------
console.log('\n=== CONFIRM via REST (the human click) ===');
const confirmed = await api(token, 'POST', `/orders/${po.id}/confirm`, { tc_accepted: true });
ok('order placed through the real engine on confirm',
  confirmed.status === 'placed' && !!confirmed.crm_order_id,
  `crm_order=${confirmed.crm_order_id} cleared=${confirmed.cleared_trades}`);

// ---- Turn 3: the agent knows what actually happened ----------------------------------
console.log('\n=== TURN 3: "did it go through?" ===');
const r3 = await chat(token, id, 'Did my sell order actually go through? What is its order number?');
console.log('--- answer ---\n' + (r3.text || '(empty)').slice(0, 900) + '\n');
ok('agent reports the real CRM order number from the system note',
  r3.text.includes(String(confirmed.crm_order_id)));

// ---- Turn 4: forward order via natural language (slice B) ----------------------------
console.log('\n=== TURN 4: forward sell for a delivery date ===');
const r4 = await chat(token, id,
  `Now set up a FORWARD sell: 1 ML of my ${REGION_NAME} allocation at $9990/ML for delivery on ` +
  `01/03/2027. It is a deliberate above-market test order. I understand forward orders rest until ` +
  `accepted and settle on the forward schedule — prepare it.`);
console.log('tools:', r4.tools.join(', ') || '(none)');
console.log('--- answer ---\n' + (r4.text || '(empty)').slice(0, 1000) + '\n');
let fwdPending = (await api(token, 'GET', `/orders?conversation_id=${id}&status=pending`))[0];
if (!fwdPending) { // allow one confirming follow-up (fat-finger price check)
  const r4b = await chat(token, id, 'Yes — $9,990/ML exactly, deliberate test price, delivery 01/03/2027. Prepare it.');
  console.log('follow-up tools:', r4b.tools.join(', ') || '(none)');
  fwdPending = (await api(token, 'GET', `/orders?conversation_id=${id}&status=pending`))[0];
}
ok('forward pending order carries the delivery date',
  fwdPending?.delivery_date === '01/03/2027' && fwdPending?.side === 'SELL',
  fwdPending ? `${fwdPending.side} ${fwdPending.volume_ml}ML delivery=${fwdPending.delivery_date}` : 'none');
const fwdConfirmed = await api(token, 'POST', `/orders/${fwdPending.id}/confirm`, { tc_accepted: true });
ok('forward order placed and RESTS (no auto-clear)',
  fwdConfirmed.status === 'placed' && !!fwdConfirmed.crm_order_id && (fwdConfirmed.cleared_trades ?? 0) === 0,
  `crm_order=${fwdConfirmed.crm_order_id} cleared=${fwdConfirmed.cleared_trades}`);

// ---- cleanup: withdraw the resting orders via the agent-independent path -------------
// (plain `node` cannot import the TS sources — extensionless imports break under type
//  stripping — so shell out to the tsx-run withdraw script, same as e2e/broker.js)
function withdraw(orderId) {
  const out = execSync(`npx tsx src/scripts/withdraw-order.ts 119063 ${orderId}`, { encoding: 'utf8' });
  return /withdrawn|placed/i.test(out);
}
ok('cleanup: order withdrawn', withdraw(confirmed.crm_order_id));
if (fwdConfirmed?.crm_order_id) {
  ok('cleanup: forward order withdrawn', withdraw(fwdConfirmed.crm_order_id));
}
// The two synchronous execSync withdraws above can idle-timeout the keep-alive socket, so a
// reused connection may RST on this final call; it is best-effort cleanup, not an assertion.
try { await api(token, 'DELETE', `/conversations/${id}`); } catch { /* keep-alive reset — ignore */ }

console.log(`\ne2e broker: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
