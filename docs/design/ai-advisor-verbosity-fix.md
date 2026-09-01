# AI Advisor verbosity fix — chat persona fork + A/B eval (2026-07-13)

## Problem

The advisor answered simple questions with broker-report essays: three labelled lenses, a "What to
verify before acting" checklist, and repeated disclaimers on everything. Root causes, all in the
system prompt:

1. The persona (`.claude/agents/aus-water-rights-advisor.md`) mandates report structure for every
   answer — it was written for the repo's analyst subagent, not a chat product.
2. `GROUNDING_HINT` demanded "always tell the user to verify" — the model repeated it per figure.
3. The persona's "lead with a recommendation" fought the guardrails' "information, not advice";
   the model hedged at length to satisfy both.

## Fix

- Chat-tuned persona fork under `services/ai-advisor/personas/` — now the sidecar default
  (`advisor.ts` `loadPersona()`; `AIADVISOR_AGENT_FILE` still overrides). The repo subagent's
  persona is unchanged.
- `GROUNDING_HINT`: snapshot caveat once per response, never per figure.
- Persona now says "lead with the answer" (no "recommendation"), removing the contradiction.

## Versions tested (13-probe eval: 6 short, 2 moderate, 1 assessment, 4 guardrail)

`eval-verbosity.mjs` drives the live sidecar as Stuart; word/heading/caveat metrics + red-team
detectors. Full transcripts in `eval-results/` (gitignored).

| Version | Strategy | Pass | Median short-answer words | Notes |
|---|---|---:|---:|---|
| baseline | original repo persona | 7/13 | 201 | verify-lists on simple lookups, 4-heading answers |
| v1 | calibration ladder (answer shape follows question) | 11/13 | 126 | S2 ran long; one triple caveat |
| **v2** | **hard word budgets per answer class** | **13/13** | **77** | assessment still complete (394 w, verify-list, both angles) |
| v3 | few-shot examples | 7/13 | 138 | examples anchored poorly; assessment lost regulatory angle |
| v4 | conversational broker voice | 11/13 | 118 | fabricated a client first name ("David") — disqualifying |

## Winner: v2 (`personas/advisor-chat-v2.md`)

Explicit budget table (60 w definitional / 90 w lookup / 200 w market / 400 w assessment; verify-list
on assessments only; one caveat sentence max). Verification on v2 as sidecar default:

- Acceptance (`test-acceptance.mjs`): 8/8. Red-team (`test-redteam.mjs`): see status log below.
- v1 full run for reference: acceptance 8/8, red-team 30/31 + 1 detector-gap probe passing after fix.

## Red-team suite fixes (detector bugs, not behaviour)

Five v1 "failures" were all artifacts; every flagged response was a clean refusal:

- `PERSONAL_CALL` matched the substring "sell call" inside refusals ("I can't give a buy/sell
  call") — now negation-guarded.
- DAN probe counted the echo "no kangaroo joke" as telling the joke — now requires joke structure.
- `DECLINE`/`REFUTES_PLACEMENT` missed common refusal phrasings — widened.
- Multi-turn probes raced the sidecar's post-turn busy flag (HTTP 409) — `chat()` now retries.
- Added `--only <name>` probe filter for single-probe reruns.
