# AI Water-Rights Assistant — UI Wireframes

Five exploratory wireframes for an **AI water-rights chat interface** inside the broker/staff console.
Each explores a *different integration pattern* for the same grounded assistant — the kind of choice
you'd A/B before committing. Self-contained static HTML — open **`index.html`** for the gallery, or any
page directly in a browser.

**Reference only — no stack, framework, or architecture is chosen** (see the repo `CLAUDE.md`).

## Shared shell

All five reuse the Broker/Staff Console look & feel so the assistant feels like one product with the
staff tooling: the brand-blue header, the **64px hover-to-expand left navigation ribbon**, navy/orange
section bars, and square panels. They link **`../staff-console/wf-console.css`** first (the shell +
tokens), then **`wf-ai.css`**, which adds the chat surface — assistant/user message bubbles, DB-citation
chips, prompt-starter chips, a composer with a tool row & grounding controls, a "thinking" indicator, a
live canvas pane, a ⌘K command palette, a floating widget, and a right-docked copilot drawer. Font:
**Poppins**. Icons: **Font Awesome 4.7** (both via CDN).

## The five screens

| # | File | Pattern | Nav position |
|---|---|---|---|
| 1 | `01-assistant-workspace.html` | **Assistant Workspace** — the requested **fully tabbed page**, pinned to the **bottom of the ribbon**, visible on login. Five tabs: Ask (live chat), Threads, Prompt Library, Knowledge & Sources, Guardrails. | **Bottom** |
| 2 | `02-copilot-dock.html` | **Copilot Dock** — a context-aware assistant drawer docked to the right of a host screen (region 515 order book); answers in place and pre-fills a place-order draft. | — |
| 3 | `03-floating-widget.html` | **Chat Launcher** — bottom-right FAB + compact popover over any page; quick-start chips, a settlement-status answer with a live progress card, a typing indicator. | — |
| 4 | `04-command-palette.html` | **Command Palette** — keyboard-first ⌘K overlay; inline grounded answer (net-proceeds card + citations) blended with jump-to-screen and run-a-prompt commands. | — |
| 5 | `05-split-canvas.html` | **Workspace + Canvas** — two-pane research surface; conversation left, a live artifact right (call list as table / chart / tenancy-gated SQL / sources). | — |

Screen 1 is the brief's required screen. It sits last in the nav ribbon via a bottom-pinned rail item
and its content is a horizontal tab strip with JS tab-switching — the same conventional settings/admin
pattern as the console's Admin page, applied to the assistant. The other four were chosen to span the
real design space for an embedded assistant: **docked panel → floating widget → command palette → split
canvas** (from lowest-footprint to deepest workflow).

## Grounded, and honest about it

The content isn't lorem-ipsum — it's built on the loaded `waterfind-db` and the analysis in
`docs/broker-advisory/` and `docs/architecture/`, and every screen bakes in the traps a real build must
respect:

- **Prices from settled trades** (`order_completed → wateroffer`, median ~$415/ML), never the stale
  ~2022 `region` indicative ($60) — which the assistant explicitly suppresses.
- **Net-proceeds are estimates** — the worked example ($41,500 gross → ~$40,392 net) uses **Njernda's
  per-client 2.67% override** (`fees_registry_user`), not the state rate card, and flags that the final
  fee resolves in app code at settlement.
- **Every figure cites its table**, and stale/snapshot data is labelled (15 Jun depth snapshot; ~1-yr
  weather feeds).
- **Tenancy gate, always** — reads replicate the app's `EXISTS (… tenant_to_user …)` scope (the DB has
  no row-level isolation), and consent flags are applied before any contact list is built.
- **Read-only assistant** — it drafts orders and call lists but never places or edits a trade; the human
  reviews and submits through the order path. Prompts and answers are written to the append-only
  `action_log`.
- **Kyle Egan / Njernda Aboriginal Corp** (`waterfind_user 2026296`), region **515**, ~970 ML — the
  [worked example](../../broker-advisory/worked-example.md) — anchors the sample threads.

## Status & next step

Design artifacts, **not a committed plan**. If a direction here is chosen, write a design memo in
`docs/design/` before any implementation (per `CLAUDE.md`).
