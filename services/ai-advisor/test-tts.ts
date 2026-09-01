/**
 * Unit tests for the text-to-speech module: markdown -> speech stripping (tables, ```chart blocks,
 * fenced code, links, emphasis, headings, lists), sentence-aware chunking, and the input
 * validation that runs BEFORE any network call, so the whole file is offline/deterministic.
 * The live OpenAI round-trip is only reachable with a real key and is exercised manually against
 * the running sidecar (see crm-seam/README.md).
 *   npx tsx test-tts.ts
 */
process.env.AIADVISOR_SPEND_LEDGER = '0';   // mocked providers must not write to the spend ledger
import {
  markdownToSpeech, chunkForSpeech, expandUnitsForSpeech, synthesizeSpeech, ttsEnabled, ttsInfo,
  buildRequest, _setFetch, TtsError,
} from './src/tts';
import { toSpoken } from './src/voice/speech';
import { config } from './src/config';

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }
function eq(a: unknown, b: unknown, msg: string) {
  ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}
function has(hay: string, needle: string, msg: string) {
  ok(hay.indexOf(needle) >= 0, `${msg} (got ${JSON.stringify(hay)}, want substring ${JSON.stringify(needle)})`);
}
function absent(hay: string, needle: string, msg: string) {
  ok(hay.indexOf(needle) < 0, `${msg} (got ${JSON.stringify(hay)}, should NOT contain ${JSON.stringify(needle)})`);
}
async function throwsStatus(fn: () => Promise<unknown>, status: number, msg: string) {
  try { await fn(); fail++; console.error('FAIL: expected a throw:', msg); }
  catch (e) {
    if (e instanceof TtsError) eq(e.status, status, msg);
    else { fail++; console.error('FAIL: wrong error type for', msg, e); }
  }
}

async function main() {
  // ---- markdown -> speech: emphasis, code, links ---------------------------
  eq(markdownToSpeech('**Bold** and _italic_ and `code`.'), 'Bold and italic and code.', 'emphasis + inline code stripped');
  eq(markdownToSpeech('See [the market page](https://example.com/x) now.'), 'See the market page now.', 'link -> anchor text only');
  absent(markdownToSpeech('Visit https://waterfind.com.au/market for prices.'), 'http', 'bare URL removed');
  has(markdownToSpeech('Visit https://waterfind.com.au/market for prices.'), 'Visit', 'text around a bare URL survives');

  // ---- markdown -> speech: headings + lists --------------------------------
  eq(markdownToSpeech('## Market summary'), 'Market summary.', 'heading -> sentence, hashes gone');
  {
    const s = markdownToSpeech('Options:\n- Sell now\n- Hold and carry over\n1. Review fees');
    has(s, 'Sell now.', 'unordered item becomes a sentence');
    has(s, 'Hold and carry over.', 'second unordered item');
    has(s, 'Review fees.', 'ordered item, number stripped');
    absent(s, '- ', 'list markers removed');
  }

  // ---- markdown -> speech: tables are NOT read cell-by-cell ----------------
  {
    const table = 'Here are prices:\n\n| Region | $/ML |\n| --- | --- |\n| Zone 1A | 120 |\n| Zone 7 | 95 |\n\nThat is the market.';
    const s = markdownToSpeech(table);
    has(s, 'See the table on screen.', 'table collapses to a screen pointer');
    absent(s, 'Zone 1A', 'table cells are not spoken');
    absent(s, '120', 'table numbers are not spoken');
    has(s, 'Here are prices:', 'text before the table survives');
    has(s, 'That is the market.', 'text after the table survives');
  }

  // ---- markdown -> speech: charts are NOT read as data ---------------------
  {
    const chart = 'Price trend:\n\n```chart\n{"type":"line","x":["Jan","Feb"],"series":[{"name":"Temp","data":[100,120]}]}\n```\n\nUp 20%.';
    const s = markdownToSpeech(chart);
    has(s, 'See the chart on screen.', 'chart block collapses to a screen pointer');
    absent(s, 'series', 'chart JSON is not spoken');
    absent(s, '"data"', 'chart data keys are not spoken');
    has(s, 'Up 20%.', 'text after the chart survives');
  }

  // ---- markdown -> speech: fenced code -------------------------------------
  {
    const s = markdownToSpeech('Run this:\n\n```js\nconsole.log(1)\n```\n\nDone.');
    has(s, 'See the code block on screen.', 'fenced code collapses to a screen pointer');
    absent(s, 'console.log', 'code contents are not spoken');
  }

  // ---- markdown -> speech: empty / whitespace-only -------------------------
  eq(markdownToSpeech(''), '', 'empty input -> empty');
  eq(markdownToSpeech('   \n\n  '), '', 'whitespace-only -> empty');
  eq(markdownToSpeech('---'), '', 'horizontal rule alone -> empty');

  // ---- chunking ------------------------------------------------------------
  eq(chunkForSpeech('short text').length, 1, 'short text -> single chunk');
  eq(chunkForSpeech('').length, 0, 'empty -> no chunks');
  {
    const sentence = 'This is a sentence about allocations. ';
    const long = sentence.repeat(80); // ~3000 chars
    const chunks = chunkForSpeech(long, 500);
    ok(chunks.length > 1, 'long text splits into multiple chunks');
    ok(chunks.every((c) => c.length <= 500), 'every chunk within the cap');
    eq(chunks.join(' ').replace(/\s+/g, ' ').trim(), long.replace(/\s+/g, ' ').trim(), 'chunks recompose to the original words');
    ok(chunks.slice(0, -1).every((c) => /[.!?]$/.test(c.trim())), 'chunks break on sentence boundaries');
  }
  {
    // a single unbroken token longer than the cap must still make progress (hard cut, no infinite loop)
    const chunks = chunkForSpeech('x'.repeat(1200), 400);
    ok(chunks.length >= 3, 'unbroken over-cap token is hard-split');
    ok(chunks.every((c) => c.length <= 400), 'hard-split chunks respect the cap');
  }

  // A chart/table-only message is NOT empty — it still says "see it on screen".
  eq(markdownToSpeech('```chart\n{}\n```'), 'See the chart on screen.', 'chart-only strips to a speakable pointer');

  // ---- synthesis validation: empty runs before the key check ---------------
  // (inputs that strip to nothing, so this is deterministic whether or not a key is set)
  await throwsStatus(() => synthesizeSpeech(''), 400, 'empty text -> 400');
  await throwsStatus(() => synthesizeSpeech('   \n\n  '), 400, 'whitespace-only -> 400 (nothing to speak)');
  await throwsStatus(() => synthesizeSpeech('---'), 400, 'rule-only -> 400 (nothing to speak)');

  // ---- trading notation -> words (shared with the phone channel) -----------
  eq(expandUnitsForSpeech('Bids sit at $95/ML for 200 ML of HS water, up 5%.'),
    'Bids sit at 95 dollars a megalitre for 200 megalitres of high security water, up 5 percent.', 'units + currency + acronyms expanded');
  eq(expandUnitsForSpeech('1 ML at $1.5m'), '1 megalitre at 1.5 million dollars', 'singular megalitre, millions');
  eq(expandUnitsForSpeech(expandUnitsForSpeech('$95/ML')), '95 dollars a megalitre', 'expansion is idempotent');
  has(toSpoken('| a | b |\n|---|---|\n| 1 | 2 |\n\nAsk at $95/ML.'), '95 dollars a megalitre', 'phone path still expands (shared helper)');
  absent(toSpoken('```chart\n{}\n```'), 'on screen', 'phone path still replaces the screen pointer');

  // ---- wire shape -----------------------------------------------------------
  {
    const r = buildRequest('Hello there.');
    eq(r.url, 'https://api.openai.com/v1/audio/speech', 'OpenAI URL');
    const body = JSON.parse(String(r.init.body));
    eq(body.input, 'Hello there.', 'body input');
    eq(body.response_format, 'mp3', 'mp3');
    ok(typeof body.voice === 'string' && typeof body.model === 'string', 'voice + model set');
    ok(/Australian/.test(String(body.instructions)), 'style instruction asks for the Australian read');
    const info = ttsInfo();
    ok(info.provider === 'openai' && info.model === body.model && info.voice === body.voice, 'ttsInfo matches the request');
  }

  // ---- synthesis against a fake provider (no network) ----------------------
  if (config.openaiApiKey) {
    const seen: Array<{ url: string; body: any }> = [];
    _setFetch(async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(Buffer.from('MP3' + seen.length), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    });
    const long = 'Prices in the Goulburn moved to $95/ML this week. '.repeat(60); // ~3000 chars -> 2 chunks at 1800
    const out = await synthesizeSpeech(long);
    ok(seen.length >= 2, 'long reply split into several provider calls', String(seen.length));
    eq(out.audio.toString(), seen.map((_, i) => 'MP3' + (i + 1)).join(''), 'chunks concatenated in order');
    has(seen[0].body.input, '95 dollars a megalitre', 'units expanded before synthesis');
    ok(out.chars > long.length, 'chars counted on the expanded speech text (units make it longer)', String(out.chars));

    // provider failure -> 502 with a generic message (no provider internals)
    _setFetch(async () => new Response('{"error":{"message":"secret internals"}}', { status: 429 }));
    await throwsStatus(() => synthesizeSpeech('Hello again.'), 502, 'provider 429 -> 502');
    _setFetch(async () => { throw new Error('ECONNRESET'); });
    await throwsStatus(() => synthesizeSpeech('Hello again.'), 502, 'network failure -> 502');
    _setFetch(null);
  } else {
    console.log('(no OpenAI key — fake-provider round-trip skipped)');
  }

  // ---- behaviour with/without a configured key -----------------------------
  if (!config.openaiApiKey) {
    eq(ttsEnabled(), false, 'ttsEnabled() false without a key');
    await throwsStatus(() => synthesizeSpeech('Hello, this is a test.'), 503, 'valid text, no key -> 503');
  } else {
    eq(ttsEnabled(), true, 'ttsEnabled() true with a key');
    console.log('(OpenAI key present — skipping the offline 503 path; use the running sidecar for the live call)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
