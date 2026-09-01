# AI Water Rights Adviser — Conversational UI Wireframes

Exploratory, high-fidelity wireframes for the client-facing conversational interface to the AI water
rights adviser. Design artifacts only — **no stack, framework, or architecture is chosen** (see the
repo `CLAUDE.md`). Self-contained static HTML; open in any browser.

## View

Open **`index.html`** for the gallery.

## Native-skin set (current) — three *integration patterns*

These reuse the live client portal's own look & feel so the adviser doesn't feel bolted on. The shared
`wf-theme.css` reconstructs the portal's design tokens from `crm/.../jsp/market/css/*` and the live
market screenshot (`market_page.PNG`): **Poppins**, brand blue `#2b6da5` + the signature orange
`#f6891f` right-border accent, the 64px hover-expand icon rail, the navy `#27406d` market title bar,
square Bootstrap-3 panels, `#eceef0` table headers, and the green "Buy this Water" / purple "Sell my
Water" buttons. Icons are Font Awesome 4.7; the real `logo_invert.png` / `swoosh.png` are referenced
from the repo.

| # | File | Pattern | Where it lives |
|---|---|---|---|
| 1 | `01-adviser-full-page.html` | **Full-page view** | A new "Adviser" item in the left icon rail; whole content area is the conversation |
| 2 | `02-adviser-drawer.html` | **Slide-in drawer** | Right-side drawer over any screen (matches the existing slide-menu / profile-popup); context-aware to the open market |
| 3 | `03-adviser-dashboard-panel.html` | **Dashboard panel** | One panel beside the Market panel on the dashboard — lowest-friction launch |

All three show the same client (Kyle Egan · Njernda, the worked example) and exercise the adviser's
signature behaviours: lead-with-the-answer verdicts, native financial tables, `Estimate` badges,
data-freshness stamps, the actual-charged fee basis, Buy/Sell CTAs wired to the real market actions,
and the read-only posture.

## Earlier exploration (archived — too divergent to integrate)

The first pass committed to three bold, distinct aesthetics. They read well alone but would clash with
the current portal and make the transition jarring, so they're superseded by the native set above.
Kept for reference:

- `01-briefing-room.html` — editorial / private-banking (light)
- `02-water-desk.html` — dark trading terminal
- `03-paddock-companion.html` — warm mobile companion

## Files

- `index.html` — gallery
- `wf-theme.css` — shared Waterfind portal theme (tokens + chat components)
- `01–03-adviser-*.html` — native integration patterns
- `0*-{briefing-room,water-desk,paddock-companion}.html` — archived exploration

## Status & next step

Reference only — **not a committed plan**. The open question is now **placement** (which pattern, or a
combination), not styling. Once chosen, write a design memo in `docs/design/` before implementation.
