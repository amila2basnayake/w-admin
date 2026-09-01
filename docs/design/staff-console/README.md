# Broker / Staff Console — UI Wireframes

Five exploratory wireframes for **internal broker & staff tooling** (the engagement goal), sharing one
application shell. Self-contained static HTML — open **`index.html`** for the gallery, or any page
directly in a browser. The left nav links the pages together as one navigable prototype.

**Reference only — no stack, framework, or architecture is chosen** (see the repo `CLAUDE.md`).

## Shared shell

All five reuse the client-portal look & feel so staff tooling feels like one product with the client
app: the brand-blue header, the **64px hover-to-expand left navigation ribbon**, navy/orange section
title bars, square Bootstrap-style panels, and the signature orange right-border accent. Tokens come
from `wf-console.css`, which extends the portal theme reconstructed in
[`../advisor-ui/wf-theme.css`](../advisor-ui/wf-theme.css) with staff components (KPI tiles, a bid/ask
order-book ladder, settlement progress bars, a horizontal tab strip, filter toolbars, status pills).
Font: **Poppins**. Icons: **Font Awesome 4.7** (both via CDN).

## The five screens

| # | File | What it is | Nav position |
|---|---|---|---|
| 1 | `01-broker-desk.html` | **Broker Desk** — dashboard: book KPIs, watched-market prices/depth, recent trades, action queue, firing alerts, settlements needing attention | Top |
| 2 | `02-markets-orderbook.html` | **Markets & Order Book** — live bid/ask ladder + depth, price strip, settled trades, place-order-on-behalf panel with estimated net & match preview | — |
| 3 | `03-client-360.html` | **Client 360** — identity/consent, holdings, tradability reach, trade history + net-proceeds breakdown, seasonal allocation, read-only advisory synthesis | — |
| 4 | `04-settlements-trust.html` | **Settlements & Trust** — settlement pipeline with stage progress, ISO-9001 trust ledger reconciled to $0, money-flow summary, disputes, compliance exceptions | — |
| 5 | `05-admin-console.html` | **Admin & Settings** — the requested **fully tabbed page**, pinned to the **bottom of the ribbon**; nine working tabs (Profile, Users & Roles, Fees & Commission, Tradability Rules, Notifications, Tenancy & Access, Integrations, Audit Log, Compliance) | **Bottom** |

Screen 5 is the brief's required screen. It sits last in the nav ribbon via a bottom-pinned rail item
(`li.bottom { margin-top:auto }`) and its content is a horizontal tab strip with JS tab-switching — a
conventional pattern for a settings/admin surface. The other four were chosen to cover the broker's
day end-to-end: **overview → trade → client → back-office → configure**.

## Grounded in the real data model

The content isn't lorem-ipsum — it's built on the loaded `waterfind-db` and the analysis in
`docs/broker-advisory/` and `docs/architecture/`, so the screens exercise the real traps a build must
handle:

- **Kyle Egan / Njernda Aboriginal Corp** (`waterfind_user 2026296`), region **515**, ~970 ML across
  six `REG` holdings — the [worked example](../../broker-advisory/worked-example.md).
- Prices from **settled trades** (`order_completed → wateroffer`, median ~$415/ML), *not* the stale
  ~2022 region indicative price ($60) — which the Markets screen explicitly suppresses.
- Order **liveness is derived** (no status column); the ladder is computed, since no best-bid/offer or
  depth table exists.
- Tradability shown through **both** the RTR *and* the STR state-gate + seasonal window (ignoring the
  STR over-reports corridors ~26%); corridor `rule` prose is display-only.
- The **net-proceeds** stack ($30,000 gross → $29,120 net, 97.1%) with fees flagged as **estimates**
  (per-client overrides resolve in app code).
- **No DB-level tenant isolation** — the Admin › Tenancy tab and every read note the mandatory
  `tenant_to_user` gate.

## Status & next step

Design artifacts, **not a committed plan**. If a direction here is chosen, write a design memo in
`docs/design/` before any implementation (per `CLAUDE.md`).
