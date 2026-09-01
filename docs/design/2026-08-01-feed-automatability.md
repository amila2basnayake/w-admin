# External-feed automatability assessment

Date: 2026-08-01. Produced by an empirical probe agent (all endpoints exercised live from the
dev machine with curl + Node 22 fetch; probe artifacts in the session scratch dir). Companion to
`2026-08-01-forecast-excellence-report.md` — assesses how automatable each source flagged by the
predictive-information research is, against the existing `refresh-extdata.ts` /
`refresh-outlooks.ts` snapshot pattern.

Effort scale: S < 2h, M half-day, L multi-day, to a production-quality refresh function.

## Ranked (most automatable first)

| # | Source | Probe result (from this machine) | Parse | Fragility | Cadence | Effort | Licence flag |
|---|---|---|---|---|---|---|---|
| 1 | NSW DPIE Tableau CSVs (trade snapshot, cumulative water balance incl. carryover, usage, utilisation) | All four 200 text/csv, no auth, real data ("Script Run 7/31/2026") | Trivial CSV | Low (view renames only) | Daily | S (all four in one function) | CC-BY, attribute |
| 2 | NVRM determination + scenario outlook | Both pages 200 plain HTML; `/outlooks/current-outlook` carries full Wet/Average/Dry/Extreme-Dry projected-determination tables with future announcement dates | HTML strip + regex (existing NVRM technique) | Low; season-rollover guard already exists | 1st + 15th monthly | S | GMW copyright, cite source |
| 3 | VIC Water Register report CSVs (BR04/BR03/BR01/R03) | Two-step POST→JSON→GET verified end-to-end, no auth: BR04 returned 299 KB / 1,232 per-trade rows (zones, ML, $/ML, dates) | CSV with 5-line preamble; bogus `text/csvf` content-type | Medium-low: recaptcha module present but not gating; hash download URL is single-use | BR04 daily/weekly; R03 (live IVT limits) daily; BR01 annual | S for BR04/BR03; M incl. BR01/R03 field discovery | YES — all-rights-reserved licence + the automated POST bypasses the UI disclaimer click-through; needs compliance review before shipping |
| 4 | BOM ENSO status | **Existing scraper bug diagnosed**: `/climate/enso/outlook/` is a tombstone (BOM retired the ENSO Outlook dial Dec 2024) so the current regex can never match. `/climate/enso/` (Southern hemisphere monitoring) is live — "El Niño firmly established… relative Niño3.4 +1.94°C… strong to very strong", issued 28 July 2026 | Anchor on `Issued <date>`, headline sentence + Niño3.4 regex | Low-medium (BOM mid-migration) | Fortnightly | S — repoint + new regex | BOM CC-BY |
| 5 | DCCEEW buyback quarterly XLSX | Blocks curl (TLS fingerprint) but **200 via Node fetch** — the refresh scripts' client. 4 stable overwrite-in-place XLSX, Last-Modified headers present | XLSX (needs `exceljs`/`xlsx` dep — none installed) | Medium: overwritten in place (keep dated copies; If-Modified-Since); active bot filter could tighten | Quarterly (poll monthly) | M | Cth CC-BY 4.0 |
| 6 | CEWH trade-intentions page | 200 via Node fetch (same bot-filter caveat) | HTML prose scrape | Medium | Monthly poll | S–M | Cth CC-BY 4.0 |
| 7 | SA water data | Legacy `csv.ashx` live but params unrecoverable without a devtools capture; **modern AQUARIUS portal export (`water.data.sa.gov.au/Export/DataSet?...&ExportFormat=csv`) answered 200 CSV no-auth** — dataset-ID discovery is the work | CSV | Low-medium | Daily | M | CC-BY |
| 8 | BOM Water Data Online KiWIS | Live over httpS (follow the 301): `getStationList`/`getParameterTypeList` JSON, no key; station mapping is the work | JSON (KISTERS standard) | Low | Daily | M | BOM CC-BY |
| 9 | NSW WAS per-valley PDFs | Statement PDFs download fine; **extraction works today** via `py -3` + PyMuPDF (installed on this machine); portable path = `pdfjs-dist`/`pdf-parse` npm dep | PDF text; scenario tables need per-layout regex | Medium (layout drift) | Fortnightly | S for headline sentences; M–L for reliable tables | NSW Crown, cite PUB number |
| 10 | WSP water markets report | 200; PDF archive 2014→2025 at a predictable URL pattern; 2025 = 5.6 MB, no challenge | Fetch+link S; figure extraction is curation, not parsing — don't automate | Low | Annual (check monthly) | S fetch / L extract (skip) | Commercial copyright — cite only, never republish |
| 11 | Rivco (ASX:RIV) monthly NAV | Official ASX API retired (404); markitdigital API works with a public token harvested from site JS — token can rotate; NAV figure is inside the announcement PDF behind an interstitial | JSON list easy; PDF hard | HIGH (token rotation, ASX ToS) | Monthly | M, accept breakage — or source from Rivco's own site | ASX ToS restrict automated redistribution |
| 12 | BOM Seasonal Streamflow Forecast | Static shell, no data-endpoint references found cheaply; one guessed URL 404'd | Unknown | Unknown — needs a browser network trace | Monthly | L / defer | BOM CC-BY |

## Wire these three first

1. **NSW DPIE Tableau CSVs** — highest signal per hour; one S-sized function adds NSW trade
   prices, allocation balance + carryover, and usage.
2. **NVRM scenario-outlook tables** — the single best allocation-forecast input (explicit
   scenario projections by date) drops straight into `authority-outlooks.json`. Fix the ENSO
   scraper (live bug: tombstone URL) in the same change.
3. **VIC Water Register BR04/BR03** — the best public southern-basin price tape, flow proven
   end-to-end — gated on the licence/disclaimer compliance review.

## Headless browser / AU-resident egress?

- Nothing probed requires AU-resident egress; everything reachable worked from this machine.
- No source strictly requires runtime headless automation. One-time manual devtools captures
  needed for: VWR R03/BR01 form fields, SA legacy csv.ashx params (or use AQUARIUS instead),
  BOM SSF (if pursued). The only realistic runtime headless dependency is ASX token refresh for
  Rivco.
- DCCEEW's TLS-fingerprint bot filter currently passes Node fetch; treat future tightening as
  the signal to reconsider.

## Dependency note

The sidecar currently ships no csv/xlsx/pdf/html parsing libraries; XLSX (buyback) and PDF
(WAS statements) rows carry that dependency cost. Also: the ENSO record currently in
`authority-outlooks.json` (issued 7 Jun 2026, "El Niño developing, ~80%") is superseded by the
live BOM page ("El Niño firmly established", issued 28 Jul 2026) — the scraper fix will pick
this up.
