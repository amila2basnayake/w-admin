// Consistency probe (option 5 measurement): ask the same predictive question repeatedly in
// fresh conversations and measure whether the quoted numbers agree across runs. With the
// precomputed house outlook (get_seasonal_outlook) the numbers should be IDENTICAL; with
// per-chat live tool calls they can drift with tool-call parameters and paraphrase.
//
//   node eval-forecast-consistency.mjs <label>      (sidecar up on :3100)
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3100';
const LABEL = process.argv[2] || 'unlabelled';
const REPEATS = 3;

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
  if (!resp.ok) throw new Error(`chat HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '';
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
    }
  }
  return { tools, text };
}

// Numbers quoted in an answer: percentages and $/ML figures, as a sorted multiset signature.
function numberSignature(text) {
  const pcts = [...text.matchAll(/(\d{1,3}(?:\.\d)?)\s*%/g)].map((m) => Number(m[1]));
  const dollars = [...text.matchAll(/\$\s?(\d[\d,]*)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  return { pcts: pcts.sort((a, b) => a - b), dollars: dollars.sort((a, b) => a - b) };
}
const overlap = (a, b) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 1 : inter / uni;
};

const QUESTIONS = [
  { id: 'Q1', msg: 'Where do you think my allocation will finish up this water year?' },
  { id: 'Q2', msg: 'What is temporary water likely to cost in my area over the next few months?' },
];

async function main() {
  const token = mint(119063, 'Stuart Hodge', 0);
  console.log(`Consistency probe [${LABEL}] — ${QUESTIONS.length} questions x ${REPEATS} repeats\n`);
  const out = [];
  for (const q of QUESTIONS) {
    const runs = [];
    for (let i = 0; i < REPEATS; i++) {
      const conv = await newConversation(token);
      const t0 = Date.now();
      const r = await chat(token, conv, q.msg);
      runs.push({
        secs: Math.round((Date.now() - t0) / 1000),
        tools: r.tools, sig: numberSignature(r.text), text: r.text,
      });
      console.log(`  ${q.id} run ${i + 1}: ${runs[i].secs}s tools=[${r.tools.join(',')}] pcts=[${runs[i].sig.pcts}] $=[${runs[i].sig.dollars}]`);
    }
    // pairwise Jaccard overlap of quoted numbers across runs
    const pairs = [];
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        pairs.push({
          pct_overlap: overlap(runs[i].sig.pcts, runs[j].sig.pcts),
          dollar_overlap: overlap(runs[i].sig.dollars, runs[j].sig.dollars),
        });
      }
    }
    const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 100) / 100 : null);
    const summary = {
      id: q.id,
      mean_pct_overlap: mean(pairs.map((p) => p.pct_overlap)),
      mean_dollar_overlap: mean(pairs.map((p) => p.dollar_overlap)),
      outlook_tool_rate: runs.filter((r) => r.tools.some((t) => /get_seasonal_outlook/.test(t))).length / runs.length,
      mean_secs: mean(runs.map((r) => r.secs)),
    };
    console.log(`  ${q.id} summary:`, JSON.stringify(summary));
    out.push({ ...summary, runs });
  }
  mkdirSync('backtest/results', { recursive: true });
  writeFileSync(`backtest/results/consistency-${LABEL}.json`, JSON.stringify({ label: LABEL, questions: out }, null, 1));
  console.log(`\nSaved backtest/results/consistency-${LABEL}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
