# AI Water Advisor — knowledge base

What the advisor grounds answers on. Maintained through the CRM's **AI Trainer Home** (the assistant
or the Library / Notes / Uploads tabs — `src/trainer/`); every change is a numbered ledger row
(`ai_advisor.kb_event`, full before/after text) and is best-effort committed to git, so any change can
be undone and the whole tree restored to a point in time or a named checkpoint.

Three collections:

| Directory | What | Delivered to the advisor how |
|---|---|---|
| `regulatory/<jur>/` | public instruments (Acts, Basin Plan, WSPs, carryover / trading / IVT rules) | `search_knowledge` / `get_knowledge_doc` |
| `library/` | material Waterfind added: uploads (annotated; original text kept in full), internal procedures, FAQs | same tools, one merged corpus (`collection: library`) |
| `notes/` | short staff guidance — a correction, a rule, a position (see `notes/README.md`) | pinned -> system prompt every turn; retrieve -> alongside search hits |

`uploads/` holds the verbatim source files (content-addressed; gitignored; never loaded as corpus).
`data/` is owned by the data workstream. No client data, live allocations or prices live here.

## Layout

```
knowledge/
  README.md                     <- this file
  regulatory/{cth,nsw,vic,sa,qld,wa,tas,cross}/<slug>.md
  library/<slug>.md             <- Waterfind material
  notes/<slug>.md               <- staff notes
  uploads/<sha256>/<filename>   <- verbatim source files (gitignored)
  data/                         <- OWNED BY THE DATA WORKSTREAM (WS-B); not part of this corpus
```

Jurisdiction directory = jurisdiction code, lower-case: `cth`, `nsw`, `vic`, `sa`, `qld`, `wa`, `tas`, `cross`.

## Frontmatter

Every `.md` (except READMEs) starts with a YAML frontmatter block. The parser is intentionally
minimal — flat `key: value` scalars plus the `source_urls` block list — keep to that shape.

Regulatory (all required):

```yaml
---
id: basin-plan-2012-water-trading-rules   # kebab-case, GLOBALLY UNIQUE across regulatory + library
title: Basin Plan 2012 — Chapter 12 Water Trading Rules
jurisdiction: CTH                          # CTH | NSW | VIC | SA | QLD | WA | TAS | CROSS; must match the folder
instrument: Basin Plan 2012 (Cth), Chapter 12
source_urls:
  - https://www.legislation.gov.au/Details/F2012L02240
as_at: 2026-07-08                          # date last verified against sources
summary: One-line description.
---
```

Library (required: `id`, `title`, `as_at`, `summary`; the rest as known):

```yaml
---
id: waterfind-carryover-desk-procedure
title: Waterfind carryover desk procedure
jurisdiction: NSW                          # optional
instrument: internal procedure             # what kind of document it is
source_file: carryover-procedure.docx      # the upload it came from
upload_id: 12
tags: carryover, nsw, iwas
source_urls:                               # optional
  - https://...
document_date: 2026-07-01                  # the document's own date, if stated
as_at: 2026-08-18
summary: One line.
---
# Title
Source: ...
## Key points
- ...
## Full text (verbatim from carryover-procedure.docx)
...
```

Notes: see `notes/README.md`.

## Body conventions

- Structured markdown: short sections, tables where they help, terse notes over prose.
- Factual only. Cite section / clause / rule / zone numbers wherever the source gives them.
- Where a rule is SEASONAL (allocations, carryover openings, IVT open/close), say so explicitly and
  add: "verify against the current-season announcement".
- No emojis. Plain-text labels.
- Every factual claim traceable to a `source_urls` entry (regulatory) or the source file (library).
  If something could not be verified, write what IS verifiable and note the gap.

## Grounding tools

`src/knowledge-tools.ts` exports `buildKnowledgeToolDefs()` (`search_knowledge`, `get_knowledge_doc`,
`list_knowledge_docs`), wired into the advisor in `src/advisor.ts` with the notes searcher injected.
`loadCorpus()` merges regulatory + library; results carry `collection` and, for library docs,
`source_file`. The loader hot-reloads on file change and serves the last good copy on a failed reload.

## Update procedure

Use the AI Trainer (CRM: AI Trainer Home) — ask the assistant, or use the Library / Notes / Uploads
tabs. Both record a ledger row and can be undone from History. Editing files by hand still works (the
loader validates and hot-reloads) but bypasses the ledger: the next Trainer change to that file records
the hand-edited text as its `before`, so nothing is lost, only unattributed. `npx tsx test-knowledge.ts`
checks the regulatory corpus offline; `npx tsx test-trainer.ts` / `itest-trainer.ts` cover the trainer.
