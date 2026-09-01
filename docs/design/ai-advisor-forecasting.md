# AI Advisor forecasting tools — methodology spec

Workstream C of `ceo-parity-plan.md`. Covers Tom's tests M5 (allocation probabilities), M6
(seasonal temp prices), M7 (long-term entitlement values). Implementation:
`services/ai-advisor/src/forecast-tools.ts`, tests `test-forecast.ts`.

## Principles (non-negotiable)

- Empirical, analogue-based, explainable. No fitted models beyond a log-linear trend; no ML.
- Ranges and distributions only — a tool NEVER returns a single point estimate.
- Every response carries: `methodology` (one paragraph), `data_as_at`, `sample_sizes`,
  `caveats[]`, and the general-information / not-financial-advice disclaimer instruction.
- The DB is a historical snapshot (readings to ~Feb 2026): "current season" is computed from the
  data's own latest date and reported as `data_as_at`, never from wall clock.
- Thin data degrades loudly: below minimum sample sizes the tool widens its pool (month → quarter,
  region → state) and says so in `caveats`, or refuses with a reason.

## Data (verified local, plus WS-B snapshots when present)

| Source | Table | Depth |
|---|---|---|
| Allocation % time series | `water_allocation_reading` (144 series via `water_allocation_region`) | 1977 → 2026-02 |
| Dam storage | `dam_reading` (257 dams; % of full storage) | ~1990s → 2026-02 (one garbage year-0006 row — filter `date_read > '1900-01-01'`) |
| SOI monthly | `soi_monthly_reading` | 1876 → 2026-06 |
| Settled trade prices | reuse Q5/Q6 source tables from `docs/broker-advisory/advisory-toolkit.sql` | verified by existing tools |
| WS-B snapshots | `knowledge/data/*.json` | current-season authoritative values (optional, graceful if absent) |

All queries run as `ai_advisor_ro` via the existing data-tools query helper (RLS GUC pattern),
region-parameterised, de-identified — same posture as the market tools.

## Tool 1 — forecast_allocation({region_id, class?})

Water season = 1 Jul–30 Jun. For each past season of the region's allocation series (per
reliability class where a region maps to >1 series):
1. Build month-of-season trajectory (forward-fill between announcement readings).
2. Let m = current month-of-season, p = latest announced % (from the series; cross-check WS-B
   snapshot when present and surface both if they disagree).
3. Analogue seasons = past seasons whose % at month m is within ±tolerance of p; widen tolerance
   stepwise until ≥8 analogues (report the tolerance used and the analogue season list).
4. Output: empirical distribution of FINAL (end-of-season) % across analogues — p10/p25/p50/p75/p90
   — plus the all-seasons base-rate distribution for context, and each analogue's final %.
5. Optional secondary conditioning on SOI phase (same-sign mean May–Jul SOI) only when it leaves
   ≥6 analogues; report whether applied.

## Tool 2 — forecast_temp_price({region_id, horizon_months≤9})

1. Monthly median settled temp price per season for the region (Q5/Q6 tables). Minimum 5 trades
   per month-cell; below that pool to quarter, then to state, and record the widening in caveats.
2. Classify past seasons into dry / median / wet terciles by that region's final allocation %.
3. For each future month in the horizon: per-tercile p25–p75 of historical prices for that
   month-of-season, level-adjusted by the ratio of the current season's observed prices to the
   analogue seasons' same-months (anchoring). Report all three scenario bands + sample sizes.
4. Prices are nominal AUD $/ML as recorded; state this. If the current season has no trades yet in
   the region, anchor to the latest 3 months of trades and say so.

## Tool 3 — forecast_entitlement_value({region_id})

1. Annual median $/ML of permanent (entitlement) sales for the region; minimum 4 sales/year else
   pool to state, recorded in caveats.
2. Report the historical annual series, and CAGR over trailing 5y / 10y / full series.
3. Projection: log-linear trend over the last 10y extended 1–5y, banded by the p25/p75 of
   historical residuals from that trend. Caveat block must name policy sensitivity (Basin Plan
   changes, carryover rule changes, buyback programs) as regime risks a trend cannot capture.

## Output contract (all three)

```json
{ "methodology": "...", "data_as_at": "YYYY-MM-DD", "inputs": {...}, "sample_sizes": {...},
  "result": {...percentiles/bands...}, "analogues_or_series": [...], "caveats": ["..."],
  "presentation": "ranges only; state methodology, data_as_at and sources; include the
   general-information not-financial-advice disclaimer; never a single number" }
```

Tool descriptions must repeat the presentation rules so the model applies them unprompted, and
must forbid the model presenting output as a personal recommendation to transact.
