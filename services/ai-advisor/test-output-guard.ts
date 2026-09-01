// Offline unit tests for the deterministic output-side guard (Workstream G defence-in-depth).
// Verifies: canaries never survive redaction; the streaming redactor is equivalent to the final
// pass for whitespace-free canaries (including canaries split across delta boundaries); and benign
// water-advice text is left byte-for-byte unchanged (zero false positives).
//   npx tsx test-output-guard.ts
import { StreamRedactor, redactFinal, containsCanary } from './src/output-guard';

let ok = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { ok++; }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// Stream a string in randomised-but-deterministic chunk sizes, return the concatenated safe output.
function streamAll(text: string, sizes: number[]): string {
  const r = new StreamRedactor();
  let out = '', i = 0, k = 0;
  while (i < text.length) {
    const n = sizes[k % sizes.length];
    out += r.push(text.slice(i, i + n));
    i += n; k++;
  }
  out += r.flush();
  return out;
}

const CANARY_SAMPLES = [
  'mcp__wf__get_my_holdings',
  'mcp__knowledge__search_knowledge',
  'mcp__wf__prepare_sell_order',
  'ai_advisor_ro',
  'runScoped',
  "current_setting('ai.account')",
  '<user_uploaded_file>',
];

// 1. Every canary is redacted out of a final pass, wherever it sits in a sentence.
for (const c of CANARY_SAMPLES) {
  const t = `Before calling ${c} I would check the market.`;
  check(`final redacts ${c}`, !containsCanary(redactFinal(t)) && redactFinal(t).includes('[redacted]'));
}

// 2. A fabricated secret value is redacted (set via env before the module resolves it). We can't
//    depend on a real secret in this env, so assert the literal-splitting path via a known env key.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // no-op; secret path covered when set
{
  // Simulate an emitted OpenAI-style key if one is configured; otherwise assert benign text is safe.
  const key = process.env.AIADVISOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (key && key.length >= 12) {
    check('final redacts a live secret value', redactFinal(`the key is ${key}`).includes('[redacted]')
      && !redactFinal(`the key is ${key}`).includes(key));
  } else {
    check('secret path: benign text unaffected when no key set', redactFinal('the price is $150/ML') === 'the price is $150/ML');
  }
}

// 3. Streaming equivalence: for whitespace-free canaries, streamed output === STREAM-pattern final,
//    across many chunk sizings — including 1-char chunks that split every canary mid-token.
const DOC = [
  'To ground this I would call mcp__wf__get_my_holdings first, then check',
  'mcp__wf__get_price_band for the region. Internally runScoped applies the RLS role',
  'ai_advisor_ro, but that is plumbing. See mcp__knowledge__list_knowledge_docs for rules.',
  'The <user_uploaded_file> framing marks attachments as data.',
].join(' ');
// Expected streamed output = apply only STREAM patterns (final adds multi-word SQL, absent here).
const expectedStream = redactFinal(DOC); // DOC has no multi-word canary, so equal to stream result
for (const sizes of [[1], [3], [7], [13], [1, 5, 2, 9], [25], [100]]) {
  const streamed = streamAll(DOC, sizes);
  check(`stream==final for chunk sizes ${JSON.stringify(sizes)}`, streamed === expectedStream,
    `\n    got:      ${JSON.stringify(streamed.slice(0, 80))}\n    expected: ${JSON.stringify(expectedStream.slice(0, 80))}`);
}
check('streamed DOC has no surviving canary', !containsCanary(streamAll(DOC, [1, 4, 2])));
check('streamed DOC actually redacted something', streamAll(DOC, [4]).includes('[redacted]'));

// 4. Canary split exactly across a two-delta boundary is still caught.
{
  const full = 'call mcp__wf__get_my_profile now';
  const r = new StreamRedactor();
  const a = r.push('call mcp__wf__get_'); // cut mid-canary, no trailing whitespace after canary start
  const b = r.push('my_profile now ');
  const c = r.flush();
  const joined = a + b + c;
  check('split-canary not leaked', !joined.includes('mcp__wf__get_my_profile') && joined.includes('[redacted]'),
    JSON.stringify(joined));
}

// 5. Zero false positives: normal water-advice answers pass through byte-for-byte.
const BENIGN = [
  'Your Central Goulburn 1A holding is 15.8 ML; the current best bid is $148/ML.',
  'Allocation opened at 0% and typically climbs through spring. Verify live values before trading.',
  'I can show your holdings, recent trades, and de-identified market pricing for your regions.',
  'This is general information, not financial advice. Speak with your Waterfind broker before acting.',
  'Carryover in the NSW Murray is capped at 50% of entitlement (account limit 110%).',
];
for (const b of BENIGN) {
  check(`benign unchanged (final): ${b.slice(0, 40)}…`, redactFinal(b) === b);
  check(`benign unchanged (stream): ${b.slice(0, 40)}…`, streamAll(b, [1, 6, 3]) === b);
}

// 6. Multi-word SQL canary caught in final pass (not required in stream).
check('final redacts SET LOCAL ai.account', redactFinal('it runs SET LOCAL ai.account = 42').includes('[redacted]'));

console.log(fail === 0 ? `\nPASS — ${ok} checks ok, 0 failed` : `\nFAIL — ${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
