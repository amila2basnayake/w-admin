# External-data snapshots (Advisor Workstream B)

Ingested, as-at-dated public datasets that ground the AI Water Advisor for Tom Rooney's tests:
**M3** (current dam storage vs historical averages) and **R1/M5 support** (allocation announcements,
current + historical, by valley). Snapshots — **not** live-scraped at question time. The tools that
read them live in `../../src/extdata-tools.ts`; the re-fetcher is `../../src/scripts/refresh-extdata.ts`.

## Datasets

| File | Contents | Records | Granularity |
|---|---|---|---|
| `dam-storage.json` | Current storage (volume GL, % full, date) for Dartmouth, Hume, Eildon, Burrinjuck, Blowering, Menindee Lakes, Lake Victoria (+ Waranga, Eppalock, Cairn Curran) + a VIC regional total | 10 storages, 1 total | Single as-at snapshot per storage |
| `dam-storage-history.json` | Dated point readings of % full per storage, seeding a same-month baseline | 7 storages, ~18 readings | Point readings (not a continuous series); July has 2 prior-year anchors for Hume/Dartmouth |
| `allocations.json` | Current-season (2026-27 opening) allocations by state/valley/licence class: NSW AWD, VIC seasonal determinations (HRWS/LRWS), SA River Murray | 22 announcements | 1 July 2026 opening determinations |
| `allocations-history.json` | Opening + final allocation % by state/valley/class/season | ~28 rows, seasons 2020-21 → 2026-27 | Per-season; marquee southern valleys, partial northern/Campaspe/Loddon |
| `bom-climate-outlook.json` | **BOM ACCESS-S rainfall outlook (long-range)** — the Bureau's own calibrated forecast, point-queried at inflow catchments + irrigation districts across every traded system (MDB, QLD coastal, TAS, WA/SA, NT) | 42 sites x 2 seasonal + 2 monthly periods | Per site per period; reissued weekly by BOM |
| `bom-weekly-outlook.json` | **BOM ACCESS-S multi-week outlook (near-term)** — next 2 weeks + 2 overlapping fortnights at the same 42 sites. Shortest period is a WEEK; no day-by-day product exists | 42 sites x 2 weekly + 2 fortnightly periods | Reissued ~twice weekly by BOM |
| `bom-region-sites.json` | **CRM region_id -> BOM site map**, generated from region names + dam/weather-station links (`npm run regionmap:build`). 1,550/1,558 regions mapped; the 8 unmapped are administrative rows | one entry per region | Regenerate after editing `src/bom-sites.ts` or when regions change |

## Conventions

- **Every record carries a date** (`as_at` / `date` / `season`) and a `source_url` + `source_name`.
- **Provenance block** per file: `{source_name, source_url[], fetched_at, licence_or_terms_note, gaps[]}`.
- **`confidence`** per record:
  - `high` — pulled directly from the authoritative operator/agency page (G-MW, WaterNSW, NVRM, SA DEW).
  - `medium` — official figure obtained via secondary reporting/search (e.g. NSW per-valley GS: the DCCEEW summary is a JS page that won't render for fetch).
  - `reported` — secondary/search extraction of a blocked or SPA primary (e.g. MDBA storage figures, pre-2026 history); indicative, re-verify before high-stakes use.
- Volumes are **GL** (1 GL = 1000 ML); `pct_full` is percent of full capacity.

## What was fetchable (Jul 2026)

- **Worked (high confidence):** Goulburn-Murray Water storage levels + Lake Eildon page; WaterNSW regional dam levels + Burrinjuck page; NVRM current + 2025-26 seasonal determinations; SA DEW opening-allocation release.
- **Blocked / not machine-readable:** `mdba.gov.au` and `riverdata.mdba.gov.au` return **HTTP 403** to non-browser fetches (Basin total, Lake Victoria current, weekly-report PDFs); `data.nsw.gov.au` AWD dataset returns 403; NSW DCCEEW allocation summary and VIC Water Register determination search are **JS SPAs** (no server-side table); NSW/SA PDFs don't parse without poppler. These gaps are recorded in each file's `provenance.gaps`.

## BOM climate outlook (`bom-climate-outlook.json` + `bom-weekly-outlook.json`)

The advisor's actual **weather forecast**, added 2026-08-04 (near-term weekly product and
national site coverage added 2026-08-06). Everything else here is observation or policy; this is
prediction, from the authority that issues it. Two horizons, one tool (`get_climate_outlook`):
**near-term** (weeks/fortnights, `refresh-bom-weekly.ts`) and **long-range** (months/seasons,
`refresh-bom-outlook.ts`). The shortest period BOM publishes through this chain is a week — the
tool and reading guides say so explicitly so day-specific questions are answered honestly.

- **Why it exists:** the only climate signal before this was the ENSO wrap-up in
  `authority-outlooks.json` — a national, qualitative statement of the *current* state of the
  Pacific. That is a diagnosis, not a forecast.
- **What it adds:** BOM's calibrated probabilistic rainfall outlook, read **per grid point at the
  inflow catchments** (Dartmouth/Hume, Eildon, Burrinjuck, Wyangala, Burrendong, Keepit, Copeton,
  Pindari, Beardmore, Fairbairn, Paradise, Tinaroo...). Storage inflow drives allocations; rainfall
  over the irrigation district does not. The matcher therefore resolves a CRM region name to its
  *catchment*, not its district — via the generated `bom-region-sites.json` id-map first (it covers
  zone names carrying no geography, like "ZONE KB - CLASS 1K"), then valley-keyword name matching
  (`src/bom-sites.ts`).
- **Headline figure:** `chance_unusually_dry_pct` — probability of landing in the driest fifth of
  the record. Baseline is **20% by construction**, so 40% is twice the normal odds.
- **Also carried (added 2026-08-05):**
  - `temperature` — chance of an unusually warm period + the 1981-2018 mean daily max in °C. Heat
    drives evaporation and irrigation demand, i.e. the demand side of price.
  - `past_accuracy` — BOM's own hindcast score at this lead and place. NOT a raw hit rate despite
    the `hit_rate/` directory it ships in: it is **weighted percent correct** (verified against
    BOM's docs and app source 2026-08-06) — % of years 1981-2018 correctly called above/below
    median, weighted by the observed anomaly. ~50% is chance; BOM's own bands: <=45 very low,
    45-55 low, 55-65 moderate, 65-75 high, >75 very high. Quoting a probability without it
    overstates what is known — and with national coverage some cells genuinely score below chance
    (e.g. October on the NSW coast), which is information the advisor should relay.
  - `recent_observations` — what ACTUALLY FELL in the last 3 completed months, against the local
    40th-60th percentile band. This is the verification loop: it is what lets the advisor say a dry
    outlook is *not* verifying. Sourced from the climagram product's observation layer.
  - `climate_drivers` (from `authority-outlooks.json`) — ENSO **plus IOD and SAM**. ENSO alone is a
    misread risk: a negative IOD can offset an El Niño over the south-east. Surfaced on the rainfall
    tool as well as `get_authority_outlooks`, because when asked "what drivers are in play" the model
    reached for the rainfall outlook and never saw IOD or SAM.

> **Units trap.** `*_odds_multiple_vs_normal` are DIMENSIONLESS multiples of the 20% baseline. They
> were briefly named `*_signal_vs_normal`, and an end-to-end run caught the advisor reporting
> `warm_signal_vs_normal: 4.6` to a client as "+4.5°C on the mean max" — a fabricated temperature
> anomaly. This dataset publishes **no forecast temperature anomaly at all**. Keep the field names
> self-describing and keep the `odds_multiples_are_not_amounts` note in `reading_guide`.
- **Endpoints:** manifest `/climate/ahead/outlooks/archive/outlook.json` (issue date, next issue
  date, model init date, headline, available periods) plus WMS `GetFeatureInfo` point queries
  against BOM's THREDDS NetCDF grids. No auth, no key, CC-BY.
- **Staleness is knowable, not guessed:** the manifest publishes `next_issue_date`, so the tool
  reports "superseded" once BOM has issued a newer outlook rather than presenting stale numbers as
  current.

Two limits are encoded in the data rather than worked around: mm totals are only retrievable for the
**first** period of each type (the WMS ignores `TIME` on the scenario files, so later periods carry
probabilities only), and the value endpoint is **undocumented internal plumbing** — a WMS proxy in
front of BOM's THREDDS server, fed a path built from an observed naming convention. It can change
without notice, unlike the published FTP forecast feeds. A coverage drop is an expected failure
mode, not a data signal. The `raw.median` product is deliberately **not** ingested: its values did
not reconcile with the calibrated products or the climatology.

## Refresh procedure — automatic

**The sidecar refreshes these itself.** `src/refresh-scheduler.ts` runs a due-ness pass 15s after
boot and every 6h thereafter, spawning each refresher as a child process (they call `process.exit()`
on failure paths, so importing one would kill the sidecar). Nothing needs to be run by hand.

Due-ness comes from the DATA's own dates, not a timer, so restarting the sidecar does not re-fire
refreshes and a sidecar that was down for a week refreshes as soon as it returns:

All calendar comparisons use the **Sydney date** (BOM's operating timezone — UTC dates cost a
~24-40h weekly window of serving a superseded outlook as current), and attempt stamps are full ISO
timestamps so backoff is hour-grained:

| Snapshot | Refreshes when |
|---|---|
| `bom-climate-outlook.json` | from BOM's own `next_issue_date` ONWARD (>=), re-checking each tick until the new issue lands; floor of 7 days. The refresher early-exits after one manifest request when the on-disk issue is still current |
| `bom-weekly-outlook.json` | every tick with >=5h backoff (its manifest has no next-issue date; the one-request early-exit makes this cheap); values pulled only when the issue date changed |
| `nsw-dashboards.json` | last attempt ≥ 1 day ago |
| `authority-outlooks.json` | last attempt ≥ 1 day ago |
| dam storage + allocations | last attempt ≥ 1 day ago |

The BOM refreshers also refuse to overwrite a healthy snapshot with a gutted one: coverage counts
**forecast probabilities** (climatology files are static and keep working when the forecast naming
convention breaks), values are range-checked at ingest (a fill value becomes null, never a served
number), and a run whose probability-coverage ratio halves vs the previous snapshot aborts with
the old data kept (`--force` overrides).

Scheduling keys off the **attempt** stamp (`last_refresh.at`), never `as_at`. Every refresher is
fail-soft, so a blocked source (MDBA 403s, a shifted G-MW DOM) keeps its old records and leaves
`as_at` behind — keying off `as_at` would mark it due forever and retry a dead endpoint every tick.

`GET /health` reports `auto_refresh` (enabled, in-flight, last run per job) alongside `started_at`
and `tool_count`. Set `ADVISOR_AUTO_REFRESH=0` to disable, `ADVISOR_REFRESH_CHECK_MS` to retune.

Manual runs remain available for a forced pull or a one-off:

```
cd services/ai-advisor
npm run data:refresh            # all snapshots
npm run climate:refresh         # BOM long-range outlook only (--force to re-pull same issue)
npm run climate:refresh-weekly  # BOM near-term outlook only
npm run regionmap:build         # regenerate the region_id -> site map (needs the local DB)
```

**Code changes still need a sidecar restart** — `npm start` has no watcher, so a long-lived process
serves the modules it imported at boot. **Data does not:** every snapshot reader hot-reloads on
mtime via `src/snapshot-cache.ts`, so a scheduler refresh reaches a running sidecar immediately.
Check `started_at` and `tool_count` on `/health` if a new tool appears to be missing.

- Uses global `fetch`, no API keys. Re-fetches the reliably-fetchable operator pages (G-MW, WaterNSW,
  NVRM) with best-effort HTML extraction and rewrites all four JSON files.
- **Tolerates partial/total failure:** a source that fails, blocks, times out, or parses to nothing
  leaves its records untouched. Each file gets a `provenance.last_refresh` report every run; a
  dataset's `fetched_at` only advances when a source actually returned parseable data.
- New storage readings are appended to `dam-storage-history.json` (deduped by date), so the
  same-time-of-year baseline densifies as the script is run over successive months.
- The G-MW/WaterNSW extractors are best-effort regex over stripped HTML; if the live DOM shifts they
  no-op (keep old data) rather than corrupt it — tune the selectors in `refresh-extdata.ts` if a run
  reports "fetched but nothing parsed" for those pages.

## Licensing / attribution

Australian government / government-owned-corporation water data. BoM, MDBA and most state water data
are published under **Creative Commons Attribution 4.0 (CC BY 4.0)** — attribute the issuing agency
(e.g. "Source: Goulburn-Murray Water", "Source: NSW DCCEEW", "Northern Victoria Resource Manager",
"SA DEW"). WaterNSW and Goulburn-Murray Water are state-owned corporations; confirm per-site terms
before redistribution. The advisor tools already instruct the model to cite source + as-at date in
every answer, which satisfies the attribution obligation at point of use.
