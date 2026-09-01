# Forecast excellence: five options built, measured, compared

Date: 2026-08-01. Branch: `feat/advisor-parity`. Everything below is reproducible from
`services/ai-advisor/backtest/` (results JSONs committed alongside).

## Why

Future-predictive questions ("where will my allocation finish?", "will temp water get dearer?")
were inconsistent in personal use and weakly covered in the test bank. Five radically different
fixes were proposed; the brief was: build them all, use the backtesting engine (option 2) as the
measuring stick, report what worked.

## The measuring stick (option 2) — built first, used throughout

`backtest/` adds **time-travel evals**: a `backtest_asof` schema of views masks every
time-stamped table to a cutoff date via a session GUC, so the *unmodified production* forecast
functions run against the past and their ranges are scored against known outcomes.

- **962 items** generated from full history: 720 allocation (20 series × up to 12 seasons × 5
  ask-months), 180 temp-price (15 regions, 6-month horizons), 62 entitlement (1–3y horizons).
- **Scores**: mean pinball loss over p10..p90 ("crps", proper scoring rule — lower is better),
  interval coverage (cov80 target 0.80, cov50 target 0.50), band width, |median error|.
- Naive baselines scored alongside: persistence ("final = today's value") and the tools' own
  unconditional base rates.

## Headline results

### A. The production forecast tools were measurably miscalibrated — and are now beatable 2–4x

| Domain (units) | Production tool | Naive persistence | Best new engine | Verdict |
|---|---|---|---|---|
| Allocation final % | crps 12.56, cov80 0.75 | crps 10.23 | **delta-hybrid: crps 9.34, cov80 0.78** | 26% better than tool; calibrated |
| Temp price (rel. to actual) | crps 0.349 | crps 0.38 | **anchored seasonal ratio: crps 0.257** | CORRECTED (skeptical review): the 26% figure was a tau-set scoring artifact — on identical quantiles the true edge is **~9%**; bands were also too narrow (cov80 0.50). Both fixed in the graduated version below. |
| Entitlement $/ML (rel.) | crps 0.24, cov50 0.39 | **crps 0.10** | **zero-drift increment: crps 0.10, cov50 0.56** | 2.4x better than tool; matches persistence AND carries honest uncertainty |

Root causes the harness exposed (each is a one-line-of-math fix, not a rewrite):

1. **Allocation**: the tool forecasts the *level* from analogue seasons and ignores the ratchet
   constraint (finals only step upward from the current announced %). From month ~4 of the season,
   naive persistence beat it. Modelling the *remaining increment* (final − current, ≥ 0) from the
   same analogues, with base-rate tails, wins at every horizon: crps by ask-month
   (baseline → delta-hybrid): m2 13.7→14.4, m4 12.8→10.6, m6 12.2→9.2, m8 12.3→7.5, m10 11.8→5.0.
2. **Temp price**: the tool's dry/median/wet bands are ~1.7× the actual price wide and their
   median is no better than the last observed price. Anchoring on the current level and applying
   the empirical distribution of same-month seasonal ratios is 26% better on the proper score.
3. **Entitlement**: the log-linear trend extrapolation badly overfits growth — "next year = this
   year" beat it by 2.4×. A zero-drift random walk with empirically-sized increments keeps the
   persistence-level accuracy and adds calibrated bands.

**Recommendation**: graduate the three winning estimators from `backtest/variants-improved.ts`
into `src/forecast-tools.ts` (keeping the existing presentation/disclaimer contract), with a
width-calibration factor for the price bands. Re-run `npx tsx backtest/run-backtest.ts improved2`
after any change — the harness is now the regression suite for forecast quality.

### B. LLM panel vs statistics (option 4): the model IS the best forecaster we have

On a stratified 60-item sample of the same time-travel allocation items (same masked data for
every panel member, LLM prompts anonymized — no region names, seasons as relative offsets — so
training-data recall of actual outcomes is blocked):

| Forecaster | crps | cov80 (→0.80) | cov50 (→0.50) | width80 | \|median err\| |
|---|---|---|---|---|---|
| statistical (delta-hybrid, the round-2 winner) | 5.88 | 0.85 | 0.73 | 45.1 | 17.3 |
| **LLM reasoning over the analogue table** | **2.30** | 0.95 | 0.87 | 35.1 | **5.0** |
| LLM aggregator (statistical + LLM + contrarian pass) | 2.64 | 0.95 | 0.88 | 40.6 | 5.2 |

- The LLM beat the best statistical engine **2.5× on the proper score, uniformly across the
  season** (per-month crps 9.96→4.74 at month 2 down to 3.94→1.50 at month 10), with tighter
  bands AND better coverage. Its rationales show why: it composes the ratchet floor, saturation
  at ~100%, analogue similarity and SOI sign jointly, where the statistical engine applies one
  fixed increment distribution.
- The **aggregator/contrarian second pass added nothing** (slightly worse than the plain LLM) —
  a one-call design wins; skip the panel machinery.
- Slight coverage over-shoot (0.95 vs 0.80 target) means it could be sharper still.
- Caveat: anonymization blocks outcome recall but trajectory fingerprinting of famous seasons
  can't be fully excluded; in production this is moot (recalling real history is a feature).

**Implication**: the cheapest production deployment of this result is prompt-level, not
infrastructure: the `forecast_allocation` tool already returns the full analogue table
(`analogues_or_series`); persona guidance telling the advisor to *reason over that table* —
ratchet floor, saturation, current-month similarity — and state its own p25–p75 range captures
most of the gain. The offline outlook generator (option 5) is where the full LLM pass belongs:
latency-free, one generation per region per week, reviewable.

### C. Routing protocol (option 1) + authority outlooks (option 3) + house outlooks (option 5)

Measured with a 16-probe battery of natural client phrasings (no trigger words like "forecast")
against the live sidecar: 10 predictive, 2 refusal-register, 4 non-predictive controls. Two
conditions: baseline persona vs the protocol persona (`advisor-chat-v2-forecast.md`), with the
new tools present in both (so the persona effect is isolated).

| Metric | Baseline persona | Protocol persona |
|---|---|---|
| Predictive → forecast_* tool invoked (strict) | 8/10 | **10/10** |
| Predictive → any forecast path (incl. house outlook) | 10/10 | 10/10 |
| Range language in answer | 10/10 | 10/10 |
| Disclaimer present | 10/10 | 10/10 |
| Authority outlook cited (option 3 corpus) | 1/16 | **7/16** |
| Control false-positives (forecast tools on non-predictive) | 0/4 | 0/4 |
| Mean predictive answer latency | 44s | **32s** |
| Refusal-register questions (by inspection) | 2/2 sound | 2/2 sound, and protocol answers name **who decides** ("a decision for the federal Water Minister and DCCEEW — I won't guess a date") exactly per the register |

Findings:

- **The tool layer does most of the routing on its own.** Even under the baseline persona,
  `get_seasonal_outlook` (deployed ~30 min earlier, never mentioned in that persona) was adopted
  spontaneously in **9/10** predictive answers, and every predictive answer already used ranges +
  disclaimers. Well-described tools are the strongest routing lever we have.
- **The protocol still adds real value at the margins**: strict forecast-tool invocation to
  10/10, authority-outlook citation ×7, faster answers (less tool wandering), and refusal answers
  shaped to the register (current rule + who decides + no guessed date).
- Two of the scorer's automated "failures" were regex artifacts, not model failures (both X1
  answers were correct and grounded) — the same detector-artifact lesson as the verbosity evals;
  final numbers above are corrected by inspection.

Consistency (option 5, same question asked 3× in fresh conversations, protocol persona):
`get_seasonal_outlook` was consulted in **6/6 runs**, and the house-outlook anchor numbers were
quoted identically every time (allocation question: the 29–30% announced / 80 / 95 / 100%
anchors in each run; price question: the $110–$187/ML band in 3/3 runs). Full numeric-set
overlap across repeats was 0.5–0.78 because answers differ in *supplementary* figures they add
around the anchors — the load-bearing numbers are stable, the garnish varies. Mean answer time
30–40s.

## Round 2 (same day): adversarial review, graduation, live card

A skeptical-review agent audited the estimators and harness before graduation. Its material
findings, all verified and acted on:

1. **The price "26% better" headline was ~3× overstated** — a tau-set artifact (`scoreQuantiles`
   averages over *available* quantiles; the old band had 3, the new 5, and tail taus are cheap).
   True same-tau edge: ~9%. Corrected above.
2. **Price bands were overconfident by construction** (small-sample empirical quantiles can't
   reach beyond the sample range; log price ratios are heavy-tailed). Its fix — tails as the
   wider of the empirical quantile and a Student-t predictive quantile (df ≤ 6 a priori,
   √(1+1/n)) — lifted cov80 0.50 → 0.69 at a flat pinball score, improving or holding in 15/15
   regions and all 6 horizons. Residual: post-2019 drought regimes still exceed the bands
   (cov80 ≈ 0.59 there); the tool's caveat says so explicitly.
3. **The allocation delta-hybrid's tail widening was level-unconditional** — on saturated
   seasons (announced ≥ 95%, 377/720 items) it forecast >100% finals with ~50-pt bands and lost
   2× to persistence. Fixed with a level-conditioned tail pool (± the tolerance ladder's 30-pt
   rung) plus a cap at the best final ever observed for the product.
4. Honesty notes adopted: items are cross-correlated (12 series × the same ~12 seasons —
   effective n is well below nominal; sub-point differences are noise), region selection is
   survivorship-bounded (results generalize to liquid regions), and entitlement rests on few
   independent observations.

**Graduated production results** (`backtest/run-backtest.ts graduated` — the tools as they now
ship, all 962 items, 57/57 unit tests passing):

| Domain | Old production | Graduated production | Notes |
|---|---|---|---|
| Allocation final % | crps 12.56 | **8.82** (cov80 0.73, width80 31 vs 48) | saturated slice 11.58 → **5.99**; era-stable (7.5 / 9.6) |
| Temp price | crps 0.349 (3-tau) | **0.28** (5-tau; 0.32 inner-tau vs 0.35), cov80 0.69 | skeptic calibration, serving on all 813 steps |
| Entitlement | crps 0.24, cov50 0.39 | **0.10**, cov50 0.62 | zero-drift increments, monotone horizon widening |

**Live Outlook Card** (`get_outlook_card`): one call composes allocation + price + entitlement +
climate driver from these engines, computed fresh per call (~150 ms — cheap enough for every
conversation), with per-domain as-at dates and loud stale-data flags. Successor to the removed
precomputed product: same card shape, live math, nothing cached. Verified end-to-end: the chat
advisor calls it per-region on broad outlook questions.

## Predictive-information research (domain agent, verified findings)

A domain-research agent surveyed what additional information would materially improve predictive
answers. Its self-audited, verified core:

- **Best single input: NVRM current outlook** — explicit Wet/Average/Dry/Extreme-Dry scenario
  projections of future determinations by date, plain HTML, no auth. Ingest next.
- **VIC Water Register CSV endpoints** (no auth, verified live): BR04/BR03 trade data
  (18,727 rows returned in test), **R03 live IVT limits** (Goulburn→Murray currently CLOSED,
  0.0 ML), BR01 aggregate carryover (Goulburn 768,571 ML at 1 Jul 2026).
- **NSW Tableau CSV endpoints** (daily, CC-BY, no auth): trade snapshot, cumulative water
  balance (incl. carryover series), usage/utilisation.
- **Entitlement-value gap-fillers**: WSP (ex-Aither) southern-Basin water markets report is free
  (next edition due ~Aug 2026; "AEI" index is now the Ricardo Entitlement Index); Rivco
  (ex-Duxton Water) publishes a monthly NAV over ~83.5 GL — a free mark-to-market proxy for the
  domain where price history alone carries no signal. Buyback tender prices per zone are now
  published for the Selected Catchments Open Tender (e.g. Murrumbidgee GS $3,185/ML).
- **Storage conditioner from `dam_reading`** (already in waterfind-db) is the cleanest
  no-dependency forecast improvement.
- **Two compliance gates before ingestion/product work**: (1) the VIC Water Register's licence
  is all-rights-reserved with an "own analysis" grant — and VIC-REGISTER is the largest provider
  in `external_sales` (289k rows), so client-facing use of VIC-derived series needs a licence
  review; (2) Water Act **Part 5A (from 1 Jul 2026)** insider-trading/market-manipulation
  provisions (ss 101H, 101JA, 101JG-JK; penalties to $728k) likely block surfacing Waterfind's
  non-public order-book depth as a client-facing forecast input without legal sign-off.
- Unverified threads (do not act on yet): BOM Seasonal Streamflow Forecast machine endpoints,
  commodity-demand drivers. Terminology note: MDBA now calls the Barmah Choke the "Barmah
  Narrows" — accept both.

## What was built (by option)

- **Option 1 — protocol**: `personas/advisor-chat-v2-forecast.md` adds a "Forecasts and
  outlooks — the one path" section: predictive-intent taxonomy → mandated tool routing → Outlook
  Card answer shape → a refusal register with redirects. Measured by
  `eval-forecast-routing.mjs` (16 natural-phrasing probes incl. controls) against the live sidecar,
  before/after.
- **Option 2 — backtesting**: `backtest/` (asof-db, items, score, run-backtest, variants-improved)
  plus results. Also doubles as an item generator for the test bank: every one of the 962 items is
  a ground-truthed predictive eval question.
- **Option 3 — authority outlooks**: `knowledge/data/authority-outlooks.json` +
  `get_authority_outlooks` tool + `src/scripts/refresh-outlooks.ts`. The refresh scraped the NSW
  DCCEEW allocation-statements index live (13 valleys, newest statements 15 Jul 2026) and carries
  the BOM/DPIRD ENSO outlook (El Niño developing, ~80% JJA 2026). Figures from secondary reporting
  are provenance-marked `confidence: "reported"` with a verification note the tool instructs the
  model to relay.
- **Option 4 — ensemble panel**: `backtest/run-ensemble.ts` runs statistical vs LLM-forecaster vs
  LLM-aggregator on a stratified 60-item sample of the same time-travel items. The LLM prompts are
  **anonymized** (no region names, seasons as relative offsets) so the model cannot recall actual
  historical outcomes from training data.
- **Option 5 — house outlooks**: `src/scripts/generate-outlooks.ts` precomputes a dated outlook
  per region (25 regions) from the winning engines + climate drivers into
  `knowledge/outlooks/latest.json`, each with a pre-rendered Outlook Card; `get_seasonal_outlook`
  serves it with quote-verbatim instructions. `eval-forecast-consistency.mjs` measures
  same-question-3x numeric agreement.

## Incidental findings / optimizations along the way

- `forecast-tools.ts` internals (season building, mature-final logic) are now exported and reused
  by the harness, so scoring semantics can never drift from tool semantics.
- The backtest runner sanity-checks itself (series/season mismatch detection; 0 skips on the
  final runs).
- Item generation found 29% of allocation items hit the tool's widest analogue tolerance (100 pts)
  — the conditioning was frequently degrading to the base rate, which explains the tool's flat crps
  across the season.
- Scraping authority PDFs from this environment is unreliable (BOM times out, DCCEEW PDFs need a
  PDF text extractor); the refresh script is built fail-soft and the statement *index* scrape works.
  A scheduled runner with poppler (or the laptop replica) could complete the pipeline.
- The pg client is session-stateful: concurrent backtest workers must not share a connection or
  the cutoff GUC leaks across items (fixed: one connection per worker).

## What worked, what didn't — and what to ship

**Worked, ship it:**

1. **Option 2 (backtesting) is the foundation and paid for itself the same day.** It found three
   concrete estimator defects, proved their fixes (2–4× accuracy), and produced 962 ground-truthed
   predictive eval items. Keep `run-backtest.ts` as the forecast regression suite and feed the
   item bank from it.
2. **Option 5 (precomputed house outlooks) measured well but is REMOVED by decision
   (2026-08-01).** For the record: it was adopted by the model in 9/10 predictive answers with
   zero prompting and quoted stable anchor numbers across repeated asks. The generator, outlook
   file and `get_seasonal_outlook` tool have been deleted; predictive answers now always come
   from the live forecast_* tools + authority outlooks. The measurement stands if the idea is
   revisited.
3. **Option 4's finding beats option 4's machinery.** A single LLM pass reasoning over the
   analogue table beat the best statistical engine 2.5× — but the aggregator/contrarian panel
   added nothing. Use the one-call LLM forecast *inside outlook generation* (offline,
   reviewable), not as per-chat infrastructure.
4. **Option 1 (protocol persona) earns its place for shape, not routing.** Routing was already
   near-perfect from the tool layer; the protocol's value is authority citation (1→7), the
   refusal register ("who decides" answers), and faster, more uniform answers. Merge the
   "Forecasts and outlooks" section of `advisor-chat-v2-forecast.md` into the production persona
   (left as a variant file to avoid colliding with concurrent persona work on this branch).
5. **Option 3 (authority outlooks) works as a corpus and needs a scheduled runner.** The NSW
   statement-index scrape works today; BOM and PDF extraction need an environment with a PDF
   text extractor (the laptop replica is a candidate host). Until then records carry
   `confidence: "reported"` and the tool makes the model say so.

**Didn't work / not worth it:**

- The ensemble aggregator pass (slightly worse than the single LLM call, at double the cost).
- The production tools' current headline distributions (allocation level-analogues, log-linear
  entitlement trend) — measurably worse than one-line replacements; graduate the winners.
- Regex-only grading of live answers — two false FAILs in 32 probes; keep automated regexes for
  screening but confirm failures by inspection (recurring lesson from the verbosity evals).

**Follow-ups in priority order:** graduate the three winning estimators into
`src/forecast-tools.ts` (+ price band widening factor); merge the protocol section into the
production persona; import the 962 backtest items into the eval suite. (House outlooks removed
by decision; authority-outlook refresh stays on-demand — no scheduled job.)

