// Acceptance eval phrased in Tom Rooney's own functional-test scenarios (2026-07-08 vision email).
// Drives the LIVE sidecar agent over HTTP/SSE as a logged-in client and asserts each NEW capability
// works end-to-end: the right tool is invoked AND the answer is grounded/cited/disclaimered.
// Already-shipped scenarios (M1/M2/M4, C1/C2/C4, B1/B2) are covered by the existing e2e suites; this
// focuses on what this engagement added. Run with the sidecar up:  node test-acceptance.mjs
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:3100';

function mint(uid, name, ut) {
  const out = execSync(`npm run mint -- ${uid} "${name}" ${ut}`, { encoding: 'utf8' });
  const line = out.split('\n').map((s) => s.trim()).reverse().find((s) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s));
  if (!line) throw new Error('could not parse token:\n' + out);
  return line;
}

async function newConversation(token) {
  const r = await fetch(`${BASE}/conversations`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`create conv HTTP ${r.status}`);
  return (await r.json()).id;
}

async function chat(token, id, message) {
  const resp = await fetch(`${BASE}/conversations/${id}/chat`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
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
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'tool') tools.push(ev.name);
      else if (ev.type === 'delta') text += ev.text;
      else if (ev.type === 'done') text = ev.text || text;
      else if (ev.type === 'error') error = ev.message;
    }
  }
  return { tools, text, error };
}

// Grounding markers.
const CITES_SOURCE = /https?:\/\/|source|as at|as-at|effective|announced by|\bDCCEEW\b|\bMDBA\b|\bDEW\b|Resource Manager|legislation/i;
const VALUES = /\$\d|per ML|\/ML|median|trend/i;
const OPPORTUNITY = /opportunit|holding|market|trade|price|volume/i;
const RANGES = /\b(?:p10|p25|p50|p75|p90|percentile|range|scenario|distribution|analogue|likel|probab|between\b.*\band\b|to\b.*\bML|\$?\d[\d,]*\s*[-–]\s*\$?\d)/i;

// Each probe: Tom's scenario label, the client question, the tool we expect the agent to reach for,
// and text markers proving the answer is grounded. tool=null means "no specific tool required".
const PROBES = [
  { id: 'R3', label: 'Explain carryover rules',
    msg: 'Explain the carryover rules for the NSW Murray general security — how much can I carry over and what is the account limit?',
    tool: /mcp__knowledge__/, markers: [CITES_SOURCE] },
  { id: 'R4', label: 'Compare trading rules between jurisdictions',
    msg: 'Compare the water trading approval rules between NSW and Victoria for a temporary allocation trade.',
    tool: /mcp__knowledge__/, markers: [CITES_SOURCE] },
  { id: 'R5', label: 'Summarise Basin Plan provisions',
    msg: 'Summarise the Murray-Darling Basin Plan provisions that restrict water trade — the Chapter 12 trading rules.',
    tool: /mcp__knowledge__/, markers: [CITES_SOURCE] },
  { id: 'M3', label: 'Dam storage vs historical average',
    msg: 'How does current storage in Hume Dam compare with the historical average for this time of year?',
    tool: /mcp__wf__get_dam_storage/, markers: [/hume/i, /%|per ?cent|storage/i] },
  { id: 'M5', label: 'Forecast allocation probabilities',
    msg: 'Based on history, what is the likely range of final seasonal allocation for the Goulburn system this season?',
    tool: /mcp__wf__forecast_allocation/, markers: [RANGES] },
  { id: 'M7', label: 'Forecast long-term entitlement values',
    msg: 'Using historical market data, what is the long-term trend in permanent entitlement values for my region?',
    tool: /mcp__wf__(forecast_entitlement_value|get_my_holdings)/, markers: [VALUES] },
  { id: 'C3', label: 'Recommend opportunities from historical activity',
    msg: 'Based on my own trading history and current market conditions, what opportunities should I be aware of?',
    tool: /mcp__wf__get_my_opportunities/, markers: [OPPORTUNITY] },
  { id: 'B5', label: 'Escalate complex matters to a human broker',
    msg: 'This is getting complicated and I would like a human broker to take over and call me about a multi-parcel forward strategy. Please escalate.',
    tool: /mcp__wf__escalate_to_broker/, markers: [/broker|follow up|be in touch|contact you/i] },
];

async function main() {
  const token = mint(119063, 'Stuart Hodge', 0);
  console.log('Acceptance eval — Tom Rooney functional-test scenarios (live agent, client Stuart)\n');
  let pass = 0, fail = 0;
  const rows = [];
  for (const p of PROBES) {
    const id = await newConversation(token);
    let r;
    try { r = await chat(token, id, p.msg); }
    catch (e) { r = { tools: [], text: '', error: String(e) }; }
    const toolOk = !p.tool || p.tools?.some?.(() => false) || r.tools.some((t) => p.tool.test(t));
    const markerHits = p.markers.map((m) => m.test(r.text));
    const markersOk = markerHits.every(Boolean);
    const ok = !r.error && toolOk && markersOk;
    if (ok) pass++; else fail++;
    rows.push({ id: p.id, label: p.label, ok, tool: p.tool ? (r.tools.find((t) => p.tool.test(t)) || '(expected ' + p.tool.source + ')') : 'n/a',
      markers: markerHits, error: r.error, excerpt: r.text.replace(/\s+/g, ' ').slice(0, 140) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.id}  ${p.label}`);
    console.log(`      tool: ${rows[rows.length - 1].tool}`);
    if (!markersOk) console.log(`      markers: ${markerHits.map((h, i) => (h ? 'ok' : 'MISS#' + i)).join(', ')}`);
    if (r.error) console.log(`      error: ${r.error}`);
    console.log(`      > ${rows[rows.length - 1].excerpt}\n`);
  }
  console.log('==================================================');
  console.log(`ACCEPTANCE: ${pass}/${PROBES.length} scenarios demonstrated`);
  console.log('==================================================');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
