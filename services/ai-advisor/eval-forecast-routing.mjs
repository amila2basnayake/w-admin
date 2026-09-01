// Forecast-routing battery (option 1 measurement) — drives the LIVE sidecar as a logged-in
// client with natural predictive phrasings (deliberately avoiding trigger words like
// "forecast"/"history") and measures whether the advisor reliably takes the forecast path:
//   route      — a forecast_* tool was invoked on predictive questions
//   range      — the answer speaks in ranges/odds, not a point or a shrug
//   control    — forecast tools NOT invoked on non-predictive questions
//
//   node eval-forecast-routing.mjs <label>      (sidecar must be up on :3100)
//
// Run once against the baseline persona and once with
// AIADVISOR_AGENT_FILE=personas/advisor-chat-v2-forecast.md to A/B the protocol section.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3100';
const LABEL = process.argv[2] || 'unlabelled';

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

const FORECAST_TOOL = /mcp__wf__forecast_/;
const RANGES = /\b(?:p10|p25|p50|p75|p90|percentile|range|scenario|distribution|analogue|likel|probab|between\b[\s\S]{0,40}\band\b|\$?\d[\d,]*\s*(?:-|to)\s*\$?\d)/i;
const NO_CRYSTAL_BALL = /can'?t (?:be )?predict|cannot (?:be )?predict|no (?:reliable )?way to (?:know|predict)|isn'?t (?:something\s+)?(?:anyone|I) can predict|not (?:something|a thing) (?:I|anyone) can (?:predict|forecast)|decided by|announced by|up to the|no such thing as a guarantee|nothing.{0,20}guaranteed|can'?t guarantee|cannot guarantee|no guarantee/i;

// Natural client phrasings — none contain "forecast", "model", or "history".
const PROBES = [
  // allocation outlook
  { id: 'A1', kind: 'predictive', msg: 'Do you reckon the Murrumbidgee general security allocation will get to 100% by the end of the season?' },
  { id: 'A2', kind: 'predictive', msg: 'Where do you think our allocation will finish up this water year?' },
  { id: 'A3', kind: 'predictive', msg: 'What are the chances we see a full allocation again next season?' },
  // temp price outlook
  { id: 'P1', kind: 'predictive', msg: 'Is temporary water going to get more expensive after Christmas?' },
  { id: 'P2', kind: 'predictive', msg: 'I am thinking of holding my water until later in the season. Will prices be better in autumn?' },
  { id: 'P3', kind: 'predictive', msg: 'What will temporary water cost around my area in a few months?' },
  // entitlement value outlook
  { id: 'E1', kind: 'predictive', msg: 'Is my entitlement likely to be worth more in five years than it is now?' },
  { id: 'E2', kind: 'predictive', msg: 'Would you expect permanent water values to keep climbing the way they have?' },
  // timing
  { id: 'T1', kind: 'predictive', msg: 'Should I sell my allocation water now or wait a couple of months?' },
  { id: 'T2', kind: 'predictive', msg: 'Is now a good time to buy temporary water, or should I hold off?' },
  // refusal register
  { id: 'X1', kind: 'refusal', msg: 'When will the government run the next buyback tender in the Basin?' },
  { id: 'X2', kind: 'refusal', msg: 'Can you guarantee prices will rise if I wait until March to sell?' },
  // controls — must NOT fire forecast tools
  { id: 'C1', kind: 'control', msg: 'What is my current water balance across my accounts?' },
  { id: 'C2', kind: 'control', msg: 'What did temporary water trade at last month in my zone?' },
  { id: 'C3', kind: 'control', msg: 'Explain the difference between general security and high security entitlements.' },
  { id: 'C4', kind: 'control', msg: 'What allocation has been announced for NSW Murray general security this season so far?' },
];

async function main() {
  const token = mint(119063, 'Stuart Hodge', 0);
  console.log(`Forecast-routing battery [${LABEL}] — ${PROBES.length} probes\n`);
  const rows = [];
  for (const p of PROBES) {
    const conv = await newConversation(token);
    const t0 = Date.now();
    let r;
    try { r = await chat(token, conv, p.msg); }
    catch (e) { r = { tools: [], text: '', error: String(e) }; }
    const secs = Math.round((Date.now() - t0) / 1000);
    const forecastToolUsed = r.tools.some((t) => FORECAST_TOOL.test(t));
    const row = {
      id: p.id, kind: p.kind, msg: p.msg, secs,
      tools: r.tools, error: r.error,
      forecast_tool: forecastToolUsed,
      range: RANGES.test(r.text),
      no_crystal_ball: NO_CRYSTAL_BALL.test(r.text),
      words: r.text.split(/\s+/).filter(Boolean).length,
      text: r.text,
    };
    let verdict;
    if (p.kind === 'predictive') verdict = forecastToolUsed && row.range ? 'PASS' : 'FAIL';
    else if (p.kind === 'refusal') verdict = row.no_crystal_ball && !/will be \$?\d|expect(?:ed)? (?:in|on) (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/i.test(r.text) ? 'PASS' : 'FAIL';
    else verdict = !forecastToolUsed ? 'PASS' : 'FAIL';
    row.verdict = verdict;
    rows.push(row);
    console.log(`  ${verdict}  ${p.id} (${p.kind}) ${secs}s  tools=[${r.tools.join(',')}] range=${row.range}${r.error ? '  ERROR ' + r.error : ''}`);
  }

  const pred = rows.filter((r) => r.kind === 'predictive');
  const ref = rows.filter((r) => r.kind === 'refusal');
  const ctl = rows.filter((r) => r.kind === 'control');
  const rate = (xs, f) => (xs.length ? Math.round((xs.filter(f).length / xs.length) * 100) : 0);
  const summary = {
    label: LABEL,
    ran_at: new Date().toISOString(),
    predictive_route_rate: rate(pred, (r) => r.forecast_tool),
    predictive_range_rate: rate(pred, (r) => r.range),
    predictive_pass_rate: rate(pred, (r) => r.verdict === 'PASS'),
    refusal_pass_rate: rate(ref, (r) => r.verdict === 'PASS'),
    control_false_positive_rate: rate(ctl, (r) => r.forecast_tool),
    overall_pass: rows.filter((r) => r.verdict === 'PASS').length + '/' + rows.length,
  };
  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  mkdirSync('backtest/results', { recursive: true });
  writeFileSync(`backtest/results/routing-${LABEL}.json`, JSON.stringify({ summary, rows }, null, 1));
  console.log(`\nSaved backtest/results/routing-${LABEL}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
