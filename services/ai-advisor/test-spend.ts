/**
 * Spend ledger — offline unit checks (no DB, no network, no model).
 *
 *   npx tsx test-spend.ts
 *
 * Covers the list-price estimators (Anthropic token pricing incl. cache tiers and SDK aliases,
 * OpenAI audio per minute, OpenAI TTS per character), the override hook, and recordSpend's
 * never-throw contract when no database is reachable.
 */
// The pool is built from the environment at import time: point it at nothing BEFORE importing so
// section 5's insert fails fast instead of writing a test row into a real ledger.
process.env.PGHOST = '127.0.0.1';
process.env.PGPORT = '1';
const { anthropicRate, priceAnthropic, totalTokens, priceOpenAiAudio, priceOpenAiTts, ratesInEffect, recordSpend, SPEND_SOURCES } = await import('./src/spend');

let pass = 0, fail = 0;
function ok(cond: unknown, msg: string) { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } }
function section(t: string) { console.log('\n' + t); }
const close = (a: number | null, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

section('1. Anthropic rates');
{
  ok(anthropicRate('claude-sonnet-5')?.input === 2 && anthropicRate('claude-sonnet-5')?.output === 10, 'claude-sonnet-5 = $2 / $10 per MTok');
  ok(anthropicRate('claude-opus-5')?.input === 5, 'claude-opus-5 = $5 in');
  ok(anthropicRate('claude-haiku-4-5-20251001')?.input === 1, 'dated haiku-4-5 id matches by substring');
  ok(anthropicRate('opus')?.input === 5 && anthropicRate('sonnet')?.input === 2 && anthropicRate('haiku')?.input === 1, 'SDK aliases opus/sonnet/haiku resolve to the current tier');
  ok(anthropicRate('claude-fable-5')?.output === 50, 'fable-5 = $50 out');
  ok(anthropicRate('claude-sonnet-4-6')?.input === 3, 'sonnet-4-6 keeps its own $3 rate (sonnet-5 must not shadow it)');
  ok(anthropicRate('gpt-4o') === null && anthropicRate('') === null && anthropicRate(null) === null, 'unknown/empty model -> null');
}

section('2. Anthropic token pricing');
{
  const usd = priceAnthropic('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  ok(close(usd, 12), '1M in + 1M out on sonnet-5 = $12.00');
  const cached = priceAnthropic('claude-sonnet-5', { input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 0 });
  ok(close(cached, 2 * 1.25 + 2 * 0.1), 'cache write ×1.25 and cache read ×0.1 of the input rate');
  ok(close(priceAnthropic('claude-opus-5', { input_tokens: 1000, output_tokens: 400 }), 0.005 + 0.01), 'small call rounds to 6 dp correctly');
  ok(priceAnthropic('nope', { input_tokens: 5 }) === null, 'unknown model -> null (quantity recorded, no cost)');
  ok(priceAnthropic('claude-opus-5', null) === null, 'no usage -> null');
  ok(totalTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }) === 20, 'totalTokens sums all four buckets');
  ok(totalTokens({ input_tokens: -1, output_tokens: NaN as any }) === 0, 'negative/NaN buckets count as 0');
}

section('3. OpenAI audio + TTS');
{
  ok(close(priceOpenAiAudio('whisper-1', 60), 0.006), 'whisper-1: 60 s = $0.006');
  ok(close(priceOpenAiAudio('gpt-4o-transcribe-diarize', 3600), 0.36), 'diarize: 1 h = $0.36');
  ok(close(priceOpenAiAudio('gpt-4o-mini-transcribe', 120), 0.006), 'mini-transcribe: 2 min = $0.006');
  ok(priceOpenAiAudio('whisper-1', 0) === null && priceOpenAiAudio('whisper-1', null) === null, 'zero/unknown seconds -> null');
  ok(priceOpenAiAudio('some-new-model', 60) === null, 'unknown STT model -> null');
  ok(close(priceOpenAiTts('gpt-4o-mini-tts', 1_000_000), 20), 'gpt-4o-mini-tts: 1M chars = $20');
  ok(close(priceOpenAiTts('gpt-4o-mini-tts', 750), 0.015), '750 chars (~1 min of speech) ≈ $0.015');
  ok(priceOpenAiTts('gpt-4o-mini-tts', 0) === null, 'no chars -> null');
}

section('4. overrides');
{
  process.env.AIADVISOR_PRICES_JSON = JSON.stringify({ anthropic: { 'claude-sonnet-5': { input: 1, output: 1 } }, openai_audio_per_min: { 'whisper-1': 0.01 }, openai_tts_per_mchars: { 'gpt-4o-mini-tts': 10 } });
  ok(close(priceAnthropic('claude-sonnet-5', { input_tokens: 1_000_000 }), 1), 'anthropic override applies');
  ok(close(priceAnthropic('sonnet', { input_tokens: 1_000_000 }), 1), 'override applies through the alias too');
  ok(close(priceOpenAiAudio('whisper-1', 60), 0.01), 'audio override applies');
  ok(close(priceOpenAiTts('gpt-4o-mini-tts', 1_000_000), 10), 'tts override applies');
  const r = ratesInEffect();
  ok(r.openai_audio_per_min['whisper-1'] === 0.01 && r.openai_audio_per_min['gpt-4o-transcribe'] === 0.006, 'ratesInEffect merges overrides over list prices');
  process.env.AIADVISOR_PRICES_JSON = '{not json';
  ok(close(priceOpenAiAudio('whisper-1', 60), 0.006), 'malformed override JSON -> list prices (warned, not thrown)');
  delete process.env.AIADVISOR_PRICES_JSON;
}

section('5. recordSpend contract');
{
  ok(SPEND_SOURCES.length === 12 && new Set(SPEND_SOURCES).size === 12, '12 distinct sources');
  // No cost and no quantity: nothing to record, resolves without touching the DB.
  let threw = false;
  try { await recordSpend({ source: 'chat', vendor: 'anthropic', costUsd: null, quantity: null }); } catch { threw = true; }
  ok(!threw, 'a row with nothing measurable resolves without a DB round-trip');
  // Zero quantity with no cost (a mocked provider, an empty stream) is not a billable event either.
  const t1 = Date.now();
  await recordSpend({ source: 'voice_agent', vendor: 'anthropic', quantity: 0, unit: 'tokens', costUsd: null });
  ok(Date.now() - t1 < 50, 'zero quantity + no cost is skipped without a DB round-trip');
  process.env.AIADVISOR_SPEND_LEDGER = '0';
  const t2 = Date.now();
  await recordSpend({ source: 'tts', vendor: 'openai', quantity: 10, unit: 'chars', costUsd: 0.0002 });
  ok(Date.now() - t2 < 50, 'AIADVISOR_SPEND_LEDGER=0 skips recording entirely');
  delete process.env.AIADVISOR_SPEND_LEDGER;
  // A real insert against an unreachable DB must log, not throw (a ledger failure never fails a turn).
  threw = false;
  const t0 = Date.now();
  try { await Promise.race([recordSpend({ source: 'tts', vendor: 'openai', quantity: 10, unit: 'chars', costUsd: 0.0002 }), new Promise<void>((r) => setTimeout(r, 4000))]); } catch { threw = true; }
  ok(!threw, `insert failure is swallowed (${Date.now() - t0} ms)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
