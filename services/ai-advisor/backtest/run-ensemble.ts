/**
 * Option 4 backtest — ensemble forecast panel (statistical + LLM + aggregator).
 *
 *   npx tsx backtest/run-ensemble.ts [sampleSize]      (default 60)
 *
 * For a stratified sample of allocation items, three forecasters produce final-%
 * quantiles from the SAME masked (as-of) data, and each is scored against the
 * known outcome:
 *   statistical — delta-hybrid variant (deterministic; the round-2 winner)
 *   llm         — Claude reasoning over an ANONYMIZED as-of data table
 *   ensemble    — Claude aggregating statistical + llm with a contrarian pass
 *
 * Data-leakage guard: the LLM prompts contain no region names, no real season
 * years (seasons are relabelled as relative offsets), and no jurisdiction — the
 * model cannot recall the historical outcome from training data; it must reason
 * from the numbers. Residual risk (trajectory fingerprinting of famous seasons)
 * is noted in the report.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AsofDb } from './asof-db';
import type { AllocItem, ItemBank } from './items';
import { computeAllocationForecast, fetchAllocationReadings, buildSeasons, trajAt } from '../src/forecast-tools';
import { allocDeltaHybridQuantiles } from './variants-improved';
import { scoreQuantiles, aggregate, aggregateBy, type QScore, type Quantiles } from './score';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(DIR, 'results');
console.debug = () => {};

// The Agent SDK is the repo's working auth path (the sidecar and its live suites run on
// it); the plain @anthropic-ai/sdk has no credentials in this environment. 'opus' is the
// same model alias the production advisor uses — which also makes this the most relevant
// comparison: "what would OUR advisor's model produce from the same data".
const MODEL = 'opus';
const CONCURRENCY = 4;

/** One-shot structured call via the Agent SDK: no tools, single turn, JSON-only reply. */
async function llmQuantiles(prompt: string): Promise<{ q: Quantiles; rationale: string } | null> {
  const q = query({
    prompt:
      prompt +
      '\n\nRespond ONLY with a single JSON object of the shape ' +
      '{"p10": number, "p25": number, "p50": number, "p75": number, "p90": number, "rationale": "one or two sentences"} ' +
      '— no markdown fences, no other text.',
    options: {
      model: MODEL,
      maxTurns: 1,
      allowedTools: [],
      systemPrompt: 'You are a quantitative forecasting engine. You respond only with the requested JSON object.',
    } as any,
  });
  let text = '';
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === 'result') text = msg.subtype === 'success' ? (msg.result ?? '') : '';
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const nums = [j.p10, j.p25, j.p50, j.p75, j.p90].map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  // enforce monotone quantiles (sort) — a proper scoring rule assumes ordered quantiles
  const vals = nums.sort((a, b) => a - b);
  return { q: { p10: vals[0], p25: vals[1], p50: vals[2], p75: vals[3], p90: vals[4] }, rationale: String(j.rationale ?? '') };
}

// ---- anonymized context builder -----------------------------------------------------
interface Ctx {
  m: number;                // current month-of-season (1=Jul..12=Jun)
  cur: number;              // current announced %
  analogues: Array<{ off: number; at_m: number | null; fin: number; soi: number | null }>;
  soiCur: number | null;
  statQ: Quantiles;
}

function buildContext(f: any, allSeasons: Array<{ season: number; atM: number | null; fin: number; soi: number | null }>, curSeason: number, statQ: Quantiles): Ctx {
  return {
    m: f.inputs.current_month_of_season,
    cur: f.inputs.current_announced_pct,
    analogues: allSeasons
      .map((s) => ({ off: s.season - curSeason, at_m: s.atM, fin: s.fin, soi: s.soi }))
      .sort((a, b) => b.off - a.off),
    soiCur: f.analogues_or_series?.length ? null : null, // current-season SOI comes via prompt line below if known
    statQ,
  };
}

function forecasterPrompt(ctx: Ctx): string {
  const rows = ctx.analogues
    .map((a) => `${a.off}\t${a.at_m == null ? '-' : a.at_m}\t${a.fin}\t${a.soi == null ? '-' : a.soi}`)
    .join('\n');
  return `You are forecasting a water allocation for an irrigation season. Water allocations are announced as a percentage of entitlement and ONLY RATCHET UPWARD within a season (the final % can never be below the current announced %). The season runs 12 months; announcements typically step up as inflows arrive, with wet years reaching 100%+ quickly and dry years stalling low.

Current situation (all identifying details removed):
- Month of season: ${ctx.m} of 12
- Current announced allocation: ${ctx.cur}%

History of past seasons for this same water product (season offset relative to now; "% at month ${ctx.m}" is what was announced at the same point of that season; "final %" is where it ended; SOI is the May-Jul Southern Oscillation Index for that season, positive = wetter-leaning La Nina, negative = drier El Nino):

offset\t% at month ${ctx.m}\tfinal %\tSOI
${rows}

Produce a probabilistic forecast (p10/p25/p50/p75/p90) of THIS season's final (end-of-season) allocation %. Respect the ratchet constraint: no quantile may be below ${ctx.cur}. Weigh seasons that looked similar at this point more heavily, consider base rates across all seasons, and remember late-season forecasts should be tight around the current level while early-season ones are wide.`;
}

function aggregatorPrompt(ctx: Ctx, llm: { q: Quantiles; rationale: string }): string {
  const s = ctx.statQ;
  return `Two independent forecasts of a water-allocation season final % are given, plus the raw data. Your job is to produce the best combined probabilistic forecast — and to act as a critic: identify what each forecast may have gotten wrong (overconfidence, ignoring the ratchet constraint, over-weighting rare wet/dry analogues, regime breaks the history cannot show) before combining.

Current: month ${ctx.m} of 12, announced ${ctx.cur}% (final cannot be below this).

Forecast A (statistical, analogue increments added to current level):
p10=${s.p10} p25=${s.p25} p50=${s.p50} p75=${s.p75} p90=${s.p90}

Forecast B (reasoned): p10=${llm.q.p10} p25=${llm.q.p25} p50=${llm.q.p50} p75=${llm.q.p75} p90=${llm.q.p90}
Rationale: ${llm.rationale}

Historical seasons (offset, % at month ${ctx.m}, final %, May-Jul SOI):
${ctx.analogues.map((a) => `${a.off}\t${a.at_m ?? '-'}\t${a.fin}\t${a.soi ?? '-'}`).join('\n')}

Where the two forecasts agree, be at least as tight as the tighter one; where they disagree, widen to cover the disagreement and say which you trust more. Output the combined p10/p25/p50/p75/p90 (no quantile below ${ctx.cur}).`;
}

// ---- SOI per season (for the anonymized table) --------------------------------------
async function fetchSoi(run: (sql: string, p?: any[]) => Promise<any[]>): Promise<Map<number, number>> {
  const rows = await run(
    `SELECT EXTRACT(YEAR FROM date_read)::int AS yr, round(avg(index_value)::numeric, 1) AS v
       FROM soi_monthly_reading
      WHERE EXTRACT(MONTH FROM date_read) IN (5, 6, 7) AND index_value IS NOT NULL
      GROUP BY yr`,
  );
  return new Map(rows.map((r) => [Number(r.yr), Number(r.v)]));
}

// ---- main ---------------------------------------------------------------------------
async function main() {
  const sampleSize = Number(process.argv[2] ?? 60);
  const bank: ItemBank = JSON.parse(readFileSync(path.join(DIR, 'items.json'), 'utf8'));

  // stratified deterministic sample: group by mos, take every k-th within each group
  const byMos = new Map<number, AllocItem[]>();
  for (const it of bank.allocation) {
    if (!byMos.has(it.mos)) byMos.set(it.mos, []);
    byMos.get(it.mos)!.push(it);
  }
  const perMos = Math.max(1, Math.floor(sampleSize / byMos.size));
  const sample: AllocItem[] = [];
  for (const [, items] of [...byMos.entries()].sort((a, b) => a[0] - b[0])) {
    const step = Math.max(1, Math.floor(items.length / perMos));
    for (let i = 0; i < items.length && sample.filter((s) => s.mos === items[0].mos).length < perMos; i += step) {
      sample.push(items[i]);
    }
  }
  console.log(`Ensemble backtest: ${sample.length} allocation items (stratified by month), model=${MODEL}`);

  // one AsofDb (= one pg connection) PER WORKER: the cutoff GUC is session state, so a
  // shared connection would let one worker's cutoff leak into another's query
  const dbs = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    const d = new AsofDb();
    await d.init();
    return d;
  }));

  const rows: Array<{
    item: AllocItem; outcome: number;
    statistical: QScore; llm: QScore | null; ensemble: QScore | null;
    llm_rationale?: string;
  }> = [];
  const failures: string[] = [];

  let idx = 0;
  async function worker(db: AsofDb) {
    for (;;) {
      const i = idx++;
      if (i >= sample.length) return;
      const item = sample[i];
      try {
        const run = db.runnerAt(item.cutoff);
        const f: any = await computeAllocationForecast(run, item.region_id);
        if (f.refused || f.inputs?.series?.id !== item.series_id) { failures.push(`${i}: baseline unusable`); continue; }

        // all usable seasons with month-m values + finals + SOI (masked data)
        const readings = await fetchAllocationReadings(run, item.series_id);
        const seasons = buildSeasons(readings);
        const curSeason = seasons[seasons.length - 1].season;
        const m = f.inputs.current_month_of_season;
        const soi = await fetchSoi(run);
        const allSeasons = seasons
          .filter((s) => s.season !== curSeason && s.finalIsMature)
          .map((s) => ({ season: s.season, atM: trajAt(s, m), fin: s.finalPct, soi: soi.get(s.season) ?? null }));
        const allDeltas = allSeasons.filter((s) => s.atM != null).map((s) => s.fin - s.atM!);
        const stat = allocDeltaHybridQuantiles(f, allDeltas);
        if (!stat) { failures.push(`${i}: no statistical quantiles`); continue; }

        const ctx = buildContext(f, allSeasons, curSeason, stat.q);
        const y = item.outcome_final_pct;

        const llm = await llmQuantiles(forecasterPrompt(ctx));
        const ens = llm ? await llmQuantiles(aggregatorPrompt(ctx, llm)) : null;

        rows.push({
          item,
          outcome: y,
          statistical: scoreQuantiles(stat.q, y),
          llm: llm ? scoreQuantiles(llm.q, y) : null,
          ensemble: ens ? scoreQuantiles(ens.q, y) : null,
          llm_rationale: llm?.rationale,
        });
        if (rows.length % 10 === 0) console.log(`  ${rows.length}/${sample.length} scored`);
      } catch (e: any) {
        failures.push(`${i}: ${e?.message ?? e}`);
      }
    }
  }
  await Promise.all(dbs.map((d) => worker(d)));
  await Promise.all(dbs.map((d) => d.close()));

  // score only items where ALL THREE variants produced a forecast (fair comparison)
  const complete = rows.filter((r) => r.llm && r.ensemble);
  const out = {
    variant: 'ensemble',
    model: MODEL,
    ran_at: new Date().toISOString(),
    sampled: sample.length,
    scored_complete: complete.length,
    failures,
    variants: {
      statistical: aggregate(complete.map((r) => r.statistical)),
      llm: aggregate(complete.map((r) => r.llm!)),
      ensemble: aggregate(complete.map((r) => r.ensemble!)),
    },
    by_mos: {
      statistical: aggregateBy(complete, (r) => `mos_${String(r.item.mos).padStart(2, '0')}`, (r) => r.statistical),
      llm: aggregateBy(complete, (r) => `mos_${String(r.item.mos).padStart(2, '0')}`, (r) => r.llm!),
      ensemble: aggregateBy(complete, (r) => `mos_${String(r.item.mos).padStart(2, '0')}`, (r) => r.ensemble!),
    },
    rows,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, 'ensemble.json');
  writeFileSync(file, JSON.stringify(out, null, 1));

  const fmt = (a: any) => a ? `n=${a.n} crps=${a.mean_crps} cov80=${a.cov80_rate} cov50=${a.cov50_rate} w80=${a.mean_width80} |err50|=${a.mean_abs_err_p50}` : 'n=0';
  console.log(`\n================ ensemble (complete items only) ================`);
  for (const [k, v] of Object.entries(out.variants)) console.log(`  ${k.padEnd(12)} ${fmt(v)}`);
  console.log(`\nFailures: ${failures.length}. Full results: ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
