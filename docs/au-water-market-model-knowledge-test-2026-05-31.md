# Model knowledge calibration — Australian water market (closed-book test)

**Date:** 2026-05-31
**Method:** A closed-book agent (no tools, pure parametric recall) listed 105 discrete, individually-tagged
claims about the AU water-rights market. Each claim was then fact-checked against authoritative sources
(MDBA, ACCC MDB water markets inquiry 2021, Water Act 2007 / Basin Plan, Victorian Water Register,
WaterNSW/NRAR, SA DEW, BOM, Aither/ABARES, company sources). Two load-bearing corrections were
independently re-verified against primary sources.

## Scorecard

| Verdict | Count | of 105 |
|---|---|---|
| Correct | 96 | 91% |
| Partly correct (right direction; imprecise/stale/mis-phrased) | 8 | 8% |
| **Incorrect** | **1** | **1%** |
| Unverifiable | 0 | 0% |

Directionally correct: ~99%. The model's parametric knowledge of AU water trading is **broad and mostly
accurate** — the core ontology (entitlement vs allocation, HRWS/LRWS, high/general security, SDLs, the
Basin Plan/MDBA/CEWH, carryover, the Barmah Choke and IVT mechanics, the 1 July–30 June water year, real
intermediaries) is correct.

## The errors (what it got wrong, with the correction)

| # | Claim (paraphrased) | Verdict | Tag | Correction |
|---|---|---|---|---|
| 99 | Basin Plan water trading rules are **enforced by the ACCC** | **INCORRECT** | `[med]` | Enforcement is the **Inspector-General of Water Compliance** (rules set by the Minister on MDBA advice). ACCC only *advises* (enforces the separate Water Charge Rules; gains new conduct-rule enforcement 1 Jul 2026). Verified on accc.gov.au. |
| 32 | Trading zone IDs: Murrumbidgee = Zone 11, Lower Darling = Zone 10 | PARTLY (2 of 5 IDs wrong) | `[med]` | Murrumbidgee = **Zone 13**, Lower Darling = **Zone 14**; **10/11 are NSW Murray** above/below the Choke. (Zone 7/6/1A were right.) Verified vs MDBA Schedule D. |
| 79 | Kilter Rural fund = "The Australian Water Trust" | PARTLY | `[med]` | **No such entity.** Kilter's vehicles are the Kilter Water Fund and the MDB Balanced Water Fund. (Duxton Water ASX:D2O and the asset-class premise are correct.) |
| 56 | Victorian Water Register operated under **DELWP** | PARTLY | `[med]` | Stale name — now **DEECA** (machinery-of-government rename, Jan 2023). Substance correct. |
| 23 | Town water, stock-and-domestic **and conveyance** rank above irrigation | PARTLY | `[med]` | Town water + S&D do rank above; **conveyance does not** — it's set commensurate with the classes it delivers. |
| 72 | Drought temp-water peaks ~$700–900/ML | PARTLY | `[med]` | Understated — 2019-20 peaks hit ~$970–1,100/ML. Direction right. |
| 81 | Entitlements on issue ~$26–30bn **across the Basin** | PARTLY | `[low]` | That figure is the **southern MDB**; the ACCC headline is ~$22.7bn (sMDB). |
| 12 | Allocation trade = inter-account or inter-holder | PARTLY | `[med]` | Substantively fine; author's gloss, not a sourced definition. |
| 101 | Carryover only against an entitlement still in the same system | PARTLY | `[low]` | Directionally right; an inference, not a verbatim rule. |

## The calibration finding (the actionable part)

**The model's self-reported confidence does NOT separate true from false.**

- The single outright-wrong claim (#99, a *regulatory-enforcement inversion*) and a *fabricated entity*
  (#79) were both tagged **`[med]`** — the same confidence as dozens of correct facts.
- Meanwhile several **`[low]`**-tagged claims were fully correct (the 200 GL Goulburn IVT limit, high-security
  entitlement prices, H2OX, Chapter 12 trading rules, NSW–QLD Border Rivers trade). The model was
  systematically **under-confident**, not over-confident — except exactly where it mattered.
- So: it knows more than it flags, but it cannot flag the things it's actually wrong about.

**Where it fails clusters precisely on what a broker tool must get right:** (a) precise regulatory
roles/responsibilities, (b) specific identifiers and numbers (zone IDs), and (c) named entities (funds,
agencies, current department names). And it states those with normal confidence.

## Implication for the engagement

This is the empirical case for **grounding domain answers in a retrieval layer with mandatory citations**,
rather than trusting the model's parametric knowledge — and for **not** using the model's own confidence as
a trust gate. The failure modes here (confident wrong regulator, swapped zone IDs, invented fund name, stale
agency name) are exactly the ones a "no regulatory/identifier claim without a cited, current source" guard is
designed to catch. The broad baseline accuracy is a tailwind; the un-flaggable ~1% is the reason to cite.
