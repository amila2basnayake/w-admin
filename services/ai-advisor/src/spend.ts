/**
 * Spend ledger — one row per billable vendor event, so the AI Trainer's Costs tab can answer "what
 * does this system cost to run" from a single table instead of four unrelated cost columns.
 *
 * Two kinds of figure land here, and the row says which:
 *  - vendor-reported (estimated = false): the Agent SDK's total_cost_usd for a turn, Retell's
 *    combined call cost. Exact to what will be invoiced.
 *  - list-price estimates (estimated = true): OpenAI never reports a dollar figure, so audio
 *    seconds / TTS characters / Messages-API token counts are priced here from the table below.
 *    Rates are list prices as at 2026-08 and can be overridden per model with AIADVISOR_PRICES_JSON.
 *
 * recordSpend never throws and never blocks the caller — a ledger failure must not fail a turn.
 * `ref` is unique when set (a turn, a note, a call): re-recording the same event is a no-op, which
 * is what lets db/spend.sql backfill history idempotently and lets retries reuse a paid transcript.
 */
import { query } from './db';

export type SpendSource =
  | 'chat' | 'assist' | 'titler'
  | 'call_note_stt' | 'call_note_draft'
  | 'dictation' | 'tts'
  | 'voice_call' | 'voice_agent'
  | 'trainer_chat' | 'trainer_annotate' | 'kb_refresh';
export type SpendVendor = 'anthropic' | 'openai' | 'retell';
export type SpendUnit = 'seconds' | 'chars' | 'tokens';

export const SPEND_SOURCES: SpendSource[] = [
  'chat', 'assist', 'titler', 'call_note_stt', 'call_note_draft', 'dictation', 'tts',
  'voice_call', 'voice_agent', 'trainer_chat', 'trainer_annotate', 'kb_refresh',
];

export interface SpendInput {
  source: SpendSource;
  vendor: SpendVendor;
  model?: string | null;
  /** USD. null = the quantity is known but nothing prices it. */
  costUsd?: number | null;
  /** true = priced here from list rates, not reported by the vendor. */
  estimated?: boolean;
  quantity?: number | null;
  unit?: SpendUnit | null;
  /** Unique event key ('message:123', 'voice_call:7'); a repeat is silently ignored. */
  ref?: string | null;
  userId?: number | null;
  at?: Date | string | null;
}

// ---- rates ---------------------------------------------------------------------------------

/** USD per million tokens. Matched by substring against the model id, first hit wins. */
type TokenRate = { input: number; output: number };
const ANTHROPIC_PER_MTOK: Array<[string, TokenRate]> = [
  ['fable-5', { input: 10, output: 50 }],
  ['mythos-5', { input: 10, output: 50 }],
  ['opus-5', { input: 5, output: 25 }],
  ['opus-4-8', { input: 5, output: 25 }],
  ['opus-4-7', { input: 5, output: 25 }],
  ['opus-4-6', { input: 5, output: 25 }],
  ['opus-4-5', { input: 5, output: 25 }],
  ['opus', { input: 15, output: 75 }],
  ['sonnet-5', { input: 2, output: 10 }],
  ['sonnet', { input: 3, output: 15 }],
  ['haiku-4-5', { input: 1, output: 5 }],
  ['haiku', { input: 0.8, output: 4 }],
];
/** Prompt-cache multipliers on the input rate (5-minute cache write, cache read). */
const CACHE_WRITE_X = 1.25, CACHE_READ_X = 0.1;
/** The Agent SDK's short aliases resolve to the current model of that tier. */
const ALIASES: Record<string, string> = { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };

/** USD per minute of audio, OpenAI speech-to-text (batch and realtime transcription sessions). */
const OPENAI_AUDIO_PER_MIN: Record<string, number> = {
  'whisper-1': 0.006,
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-transcribe-diarize': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
};
/** USD per million input characters, OpenAI text-to-speech (gpt-4o-mini-tts ≈ $0.015/min of speech). */
const OPENAI_TTS_PER_MCHARS: Record<string, number> = {
  'gpt-4o-mini-tts': 20,
  'tts-1': 15,
  'tts-1-hd': 30,
};

interface PriceOverrides {
  anthropic?: Record<string, TokenRate>;
  openai_audio_per_min?: Record<string, number>;
  openai_tts_per_mchars?: Record<string, number>;
}
function overrides(): PriceOverrides {
  const raw = process.env.AIADVISOR_PRICES_JSON;
  if (!raw) return {};
  try { return JSON.parse(raw) as PriceOverrides; } catch { console.warn('[spend] AIADVISOR_PRICES_JSON is not valid JSON; list prices in effect'); return {}; }
}

export function anthropicRate(model: string | null | undefined): TokenRate | null {
  const id = (ALIASES[String(model ?? '').trim()] ?? String(model ?? '')).toLowerCase();
  if (!id) return null;
  const o = overrides().anthropic;
  if (o && o[id]) return o[id];
  for (const [needle, rate] of ANTHROPIC_PER_MTOK) if (id.includes(needle)) return rate;
  return null;
}

export interface TokenUsage {
  input_tokens?: number | null; output_tokens?: number | null;
  cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null;
}
/** USD for one Messages-API call at list price, or null when the model is unknown. */
export function priceAnthropic(model: string | null | undefined, usage: TokenUsage | null | undefined): number | null {
  const r = anthropicRate(model);
  if (!r || !usage) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const usd = (n(usage.input_tokens) * r.input
    + n(usage.cache_creation_input_tokens) * r.input * CACHE_WRITE_X
    + n(usage.cache_read_input_tokens) * r.input * CACHE_READ_X
    + n(usage.output_tokens) * r.output) / 1_000_000;
  return round6(usd);
}
export function totalTokens(usage: TokenUsage | null | undefined): number {
  if (!usage) return 0;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens) + n(usage.output_tokens);
}

/** USD for `seconds` of audio through an OpenAI STT model, or null when the model has no rate. */
export function priceOpenAiAudio(model: string | null | undefined, seconds: number | null | undefined): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const id = String(model ?? '').trim();
  const rate = overrides().openai_audio_per_min?.[id] ?? OPENAI_AUDIO_PER_MIN[id];
  return typeof rate === 'number' ? round6((seconds / 60) * rate) : null;
}
/** USD for `chars` of input text through an OpenAI TTS model, or null when the model has no rate. */
export function priceOpenAiTts(model: string | null | undefined, chars: number | null | undefined): number | null {
  if (typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) return null;
  const id = String(model ?? '').trim();
  const rate = overrides().openai_tts_per_mchars?.[id] ?? OPENAI_TTS_PER_MCHARS[id];
  return typeof rate === 'number' ? round6((chars / 1_000_000) * rate) : null;
}
/** The rate tables in effect (overrides applied), for the Costs tab. */
export function ratesInEffect() {
  const o = overrides();
  return {
    anthropic_per_mtok: { ...Object.fromEntries(ANTHROPIC_PER_MTOK), ...(o.anthropic ?? {}) },
    cache: { write_x: CACHE_WRITE_X, read_x: CACHE_READ_X },
    openai_audio_per_min: { ...OPENAI_AUDIO_PER_MIN, ...(o.openai_audio_per_min ?? {}) },
    openai_tts_per_mchars: { ...OPENAI_TTS_PER_MCHARS, ...(o.openai_tts_per_mchars ?? {}) },
  };
}
function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }

// ---- write ---------------------------------------------------------------------------------

/** AIADVISOR_SPEND_LEDGER=0 switches recording off (the offline unit suites set it: their mocked
 *  providers would otherwise write phantom rows into whatever database .env points at). */
export function spendLedgerEnabled(): boolean { return process.env.AIADVISOR_SPEND_LEDGER !== '0'; }

/** Append one event. Fire-and-forget safe: resolves on failure after logging, never rejects. */
export async function recordSpend(s: SpendInput): Promise<void> {
  if (!spendLedgerEnabled()) return;
  const cost = typeof s.costUsd === 'number' && Number.isFinite(s.costUsd) ? s.costUsd : null;
  const qty = typeof s.quantity === 'number' && Number.isFinite(s.quantity) && s.quantity > 0 ? s.quantity : null;
  if (cost == null && qty == null) return;                       // nothing billable happened
  try {
    await query(
      `INSERT INTO spend (at, source, vendor, model, cost_usd, estimated, quantity, unit, ref, user_id)
       VALUES (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING`,
      [s.at ?? null, s.source, s.vendor, s.model ? String(s.model).slice(0, 120) : null, cost, !!s.estimated,
       qty, s.unit ?? null, s.ref ? String(s.ref).slice(0, 200) : null, s.userId ?? null],
    );
  } catch (e: any) {
    console.warn(`[spend] not recorded (${s.source}): ${e?.message ?? e}`);
  }
}

// ---- read (the Costs tab) ------------------------------------------------------------------

export interface SpendSummary {
  currency: 'USD';
  tz: string;
  days: number;
  totals: {
    today: number; d7: number; d30: number; all: number; window: number;
    /** The estimated (list-priced) share of each figure — the UI marks a figure ≈ when this is > 0. */
    today_estimated: number; d7_estimated: number; d30_estimated: number; all_estimated: number; window_estimated: number;
  };
  sources: Array<{
    source: string; vendor: string; events: number; window_usd: number; window_estimated_usd: number;
    all_usd: number; all_events: number; quantity: number | null; unit: string | null; models: string[];
  }>;
  daily: Array<{ day: string; usd: number; by_source: Record<string, number> }>;
  recent: Array<{
    id: number; at: string; source: string; vendor: string; model: string | null; cost_usd: number | null;
    estimated: boolean; quantity: number | null; unit: string | null; ref: string | null; user_id: number | null;
  }>;
  rates: ReturnType<typeof ratesInEffect>;
}

export async function spendSummary(opts: { days?: number; tz: string; recent?: number }): Promise<SpendSummary> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), 366);
  const recentN = Math.min(Math.max(Math.trunc(opts.recent ?? 40), 1), 200);
  const tz = opts.tz;
  const f = (v: unknown) => (v == null ? 0 : Number(v));

  const [totals, sources, daily, recent] = await Promise.all([
    query(
      `SELECT coalesce(sum(cost_usd) FILTER (WHERE (at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date), 0)::float8 AS today,
              coalesce(sum(cost_usd) FILTER (WHERE estimated AND (at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date), 0)::float8 AS today_est,
              coalesce(sum(cost_usd) FILTER (WHERE at >= now() - interval '7 days'), 0)::float8  AS d7,
              coalesce(sum(cost_usd) FILTER (WHERE estimated AND at >= now() - interval '7 days'), 0)::float8  AS d7_est,
              coalesce(sum(cost_usd) FILTER (WHERE at >= now() - interval '30 days'), 0)::float8 AS d30,
              coalesce(sum(cost_usd) FILTER (WHERE estimated AND at >= now() - interval '30 days'), 0)::float8 AS d30_est,
              coalesce(sum(cost_usd), 0)::float8 AS all_usd,
              coalesce(sum(cost_usd) FILTER (WHERE estimated), 0)::float8 AS all_est,
              coalesce(sum(cost_usd) FILTER (WHERE at >= now() - ($2 || ' days')::interval), 0)::float8 AS window_usd,
              coalesce(sum(cost_usd) FILTER (WHERE estimated AND at >= now() - ($2 || ' days')::interval), 0)::float8 AS window_est
         FROM spend`, [tz, String(days)]),
    query(
      `SELECT source, vendor,
              count(*) FILTER (WHERE at >= now() - ($1 || ' days')::interval)::int AS events,
              coalesce(sum(cost_usd) FILTER (WHERE at >= now() - ($1 || ' days')::interval), 0)::float8 AS window_usd,
              coalesce(sum(cost_usd) FILTER (WHERE estimated AND at >= now() - ($1 || ' days')::interval), 0)::float8 AS window_est,
              coalesce(sum(cost_usd), 0)::float8 AS all_usd,
              count(*)::int AS all_events,
              sum(quantity) FILTER (WHERE at >= now() - ($1 || ' days')::interval)::float8 AS quantity,
              max(unit) AS unit,
              array_remove(array_agg(DISTINCT model), NULL) AS models
         FROM spend
        GROUP BY source, vendor
        ORDER BY window_usd DESC, all_usd DESC`, [String(days)]),
    query(
      `SELECT (at AT TIME ZONE $1)::date::text AS day, source, coalesce(sum(cost_usd), 0)::float8 AS usd
         FROM spend
        WHERE at >= (date_trunc('day', now() AT TIME ZONE $1) - (($2::int - 1) || ' days')::interval) AT TIME ZONE $1
        GROUP BY 1, 2 ORDER BY 1`, [tz, days]),
    query(
      `SELECT id, at, source, vendor, model, cost_usd::float8 AS cost_usd, estimated, quantity::float8 AS quantity, unit, ref, user_id
         FROM spend ORDER BY at DESC, id DESC LIMIT $1`, [recentN]),
  ]);

  // Every day of the window appears, zero or not, so the chart's x-axis is continuous.
  const byDay = new Map<string, { usd: number; by_source: Record<string, number> }>();
  for (const r of daily.rows) {
    const d = byDay.get(r.day) ?? { usd: 0, by_source: {} };
    d.usd += f(r.usd);
    d.by_source[r.source] = (d.by_source[r.source] ?? 0) + f(r.usd);
    byDay.set(r.day, d);
  }
  const todayLocal = await query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [tz]);
  const end = new Date(todayLocal.rows[0].d + 'T00:00:00Z');
  const series: SpendSummary['daily'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end.getTime() - i * 86400_000).toISOString().slice(0, 10);
    const d = byDay.get(day);
    series.push({ day, usd: d?.usd ?? 0, by_source: d?.by_source ?? {} });
  }

  const t = totals.rows[0] ?? {};
  return {
    currency: 'USD', tz, days,
    totals: {
      today: f(t.today), d7: f(t.d7), d30: f(t.d30), all: f(t.all_usd), window: f(t.window_usd),
      today_estimated: f(t.today_est), d7_estimated: f(t.d7_est), d30_estimated: f(t.d30_est),
      all_estimated: f(t.all_est), window_estimated: f(t.window_est),
    },
    sources: sources.rows.map((r: any) => ({
      source: r.source, vendor: r.vendor, events: Number(r.events), window_usd: f(r.window_usd),
      window_estimated_usd: f(r.window_est), all_usd: f(r.all_usd), all_events: Number(r.all_events),
      quantity: r.quantity == null ? null : Number(r.quantity), unit: r.unit ?? null,
      models: Array.isArray(r.models) ? r.models : [],
    })),
    daily: series,
    recent: recent.rows.map((r: any) => ({
      id: Number(r.id), at: r.at instanceof Date ? r.at.toISOString() : String(r.at), source: r.source, vendor: r.vendor,
      model: r.model ?? null, cost_usd: r.cost_usd == null ? null : Number(r.cost_usd), estimated: !!r.estimated,
      quantity: r.quantity == null ? null : Number(r.quantity), unit: r.unit ?? null, ref: r.ref ?? null,
      user_id: r.user_id == null ? null : Number(r.user_id),
    })),
    rates: ratesInEffect(),
  };
}
