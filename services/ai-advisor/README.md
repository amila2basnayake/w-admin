# Waterfind AI Advisor — sidecar service

Streams the real **`aus-water-rights-advisor`** agent (Claude Agent SDK, opus) to a ChatGPT-style
chat page embedded in the legacy CRM client portal, with per-user conversation persistence,
tenant-scoped data grounding (41 curated tools under RLS: client/market data, account-setup review,
external dam-storage and allocation snapshots, forecasting, brokerage workflow), a public 3-tool regulatory knowledge
corpus (`knowledge/`), and **brokerage**: the advisor can
prepare real buy/sell orders (and withdrawals) that execute through the CRM's live trade engine
only after the user explicitly confirms on an in-chat card. Answers render markdown tables and
fenced ```chart blocks as interactive inline-SVG charts (hover readout, table view).

Design & rationale: [`../../docs/design/water-advisor-chat.md`](../../docs/design/water-advisor-chat.md)
(chat + grounding) and [`../../docs/design/ai-brokerage.md`](../../docs/design/ai-brokerage.md)
(order execution, scope model, trust boundaries).

## Architecture (v1)

```
Browser (CRM /user-home.html, "AI Advisor" tab)
  → iframe loads /ai-advisor.html  (CRM JSP: mints a short-lived HMAC token from the CRM session)
  → SPA calls this sidecar with `Authorization: Bearer <token>` (fetch + SSE stream)
  → sidecar verifies token → per-user scope; runs the advisor via the Agent SDK; streams deltas
  → Postgres schema `ai_advisor` (own tables, keyed by CRM waterfind_user.id)
```

The advisor runs sandboxed: inline agent definition (system prompt from
`.claude/agents/aus-water-rights-advisor.md`), `WebSearch` only, no filesystem/DB tools, empty
`cwd`, no project settings loaded.

## Prerequisites

- Node 18+ (tested on v22).
- The running local Postgres 9.6 `waterfind-db` (see the `run-crm` skill).
- Claude auth: either `ANTHROPIC_API_KEY` in `.env`, or the host's Claude Code credentials
  (`~/.claude`) — the SDK uses those automatically if no key is set.

## Setup

```bash
cd services/ai-advisor
npm install
cp .env.example .env          # then set AIADVISOR_SHARED_SECRET (see below)

# generate a shared secret and write it to BOTH the sidecar .env and the JSP-readable file:
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
# .env:                      AIADVISOR_SHARED_SECRET=$SECRET
# ${HOME}/.waterfind-ai-advisor.properties:   wf.ai.secret=$SECRET  (+ wf.ai.base-url, wf.ai.token-ttl)

npm run db:init               # create the ai_advisor schema + tables
```

The CRM JSP (`crm/.../jsp/userhome/app/ai-advisor.jsp`) reads the secret and base URL from
`${user.home}/.waterfind-ai-advisor.properties` — kept **outside** both repos so it is never
committed. It must match `AIADVISOR_SHARED_SECRET`.

## Run

```bash
npm run dev      # tsx watch on :3100  (or: npm start)
```

Then in the CRM (Resin on :81) log in as a client and open **AI Advisor** in the left menu.

## Verify

```bash
npm run smoke:agent                 # one real advisor turn via the Agent SDK
npx tsx src/scripts/itest.ts        # full HTTP integration test (server must be running)
npx tsx test-tools.ts               # data/broker tool handlers + cross-tenant RLS proof
npx tsx test-knowledge.ts           # regulatory corpus: frontmatter, ids, search probes (offline)
npx tsx test-extdata.ts             # dam storage + allocation snapshots and tools (offline)
npx tsx test-forecast.ts            # forecasting: analogues, price scenarios, entitlement trend
npx tsx test-workflow.ts            # broker notification + escalation (CRM broker_action)
npx tsx test-opportunities.ts       # get_my_opportunities: isolation + observation integrity
npx tsx test-tts.ts                 # voice: markdown-to-speech, chunking, key gating (offline)
npx tsx test-output-guard.ts        # L9 output guard: canary/secret redaction, stream==final (offline)
node test-acceptance.mjs            # LIVE agent: 8 of Tom Rooney's functional-test scenarios end-to-end
npx tsx test-broker.ts              # brokerage: scope, IDOR, lifecycle + a REAL crossing trade (CRM must be up)
npx tsx itest-broker.ts             # brokerage HTTP layer (confirm/cancel endpoints, system notes)
node test-e2e-broker.mjs            # LIVE agent: prepare via chat, refuse out-of-scope, confirm, report
node test-redteam.mjs               # LIVE agent: adversarial red-team (injection, tenant-escape, advice, orders, scope)
npx tsx itest-attachments.ts        # attachments: upload validation, IDOR, LIVE csv/image/pdf turns
npx tsx test-transcribe.ts          # dictation clip path: mime mapping + input validation (offline, no key)
npm run test:transcribe-stream      # live dictation relay: protocol + fake upstream (offline); LIVE=1 adds the real round-trip
npm run test:voice                  # phone channel: normalisation, affirmation, guards, tier gate (offline)
npm run test:voice-protocol         # phone channel: fake Retell drives the real websocket + webhook end to end
npm run itest:voice                 # phone channel: same driver, LIVE model (needs CRM for placement)
npm run test:trainer                # AI Trainer: store/ledger/restore, notes, ingestion helpers (offline)
npm run itest:trainer               # AI Trainer: real DB + scratch KNOWLEDGE_DIR
npm run test:call-notes             # call notes: PBX client, WAV split, transcript, drafting, store, worker, prefill decision (offline)
npm run itest:call-notes            # call notes: seeded calls pre-drafted, then the Add Comment prefill route end to end (fake PBX, real STT + draft)
npm run test:assist                 # broker-assist surface: act-claim tokens, staff/role gate, scoping
cd e2e && npm install && node test.js && node broker.js   # browser tests against the running CRM
cd e2e && node charts.js            # chart/table presentation: seeded render checks + one live turn
cd e2e && node attachments.js       # attachments UI: chips, live csv+image turns, reload thumbnails
cd e2e && node call-notes.js        # Add Comment popup opens prefilled with the drafted note (CRM + sidecar + fake PBX + a seeded call; see the file header)
cd e2e && node assist-orders.js     # Client Rail brokerage: broker logs in, places a sell for the client from the rail card, withdraws it, declines another
```

## Brokerage (order execution)

The agent's `prepare_sell_order` / `prepare_buy_order` / `prepare_order_withdrawal` tools only
create a **pending** row (`ai_advisor.pending_order`, 30-min TTL) after validating scope against
the caller's own resources. The chat UI renders a confirmation card; `POST /orders/:id/confirm`
(the user's bearer token — the model has no path to it) executes through the CRM engine via the
HMAC-signed JSP seam (`crm-seam/` — install notes there; `AIADVISOR_EXEC_SECRET` +
`AIADVISOR_CRM_BASE` in `.env`). Outcomes are written back into the conversation as `system`
notes, which are the model's authoritative record of what happened. Apply `db/brokerage.sql`
alongside `db/schema.sql`.

**Broker-assist (Client Rail):** the same tools and the same `confirmPendingOrder()` run for a
verified staff member acting for the client — ctx is still the client, so scope, re-validation
and placement are identical. The rail's card is confirmed with the staff token
(`GET /assist/orders`, `POST /assist/orders/:id/confirm|cancel`; only cards staged from that
client's assist chats are reachable — a card in the client's own chat stays the client's). The
staff member is recorded on the row (`staff_user_id` / `staff_name`), in the CRM contact note
(seam `placedBy`) and on the broker task; the escalate-to-a-broker tools are the only ones
withheld on that surface.

Order shapes: spot (default), **forward** (`delivery_date` dd/MM/yyyy — future-only, 24-month
horizon; forwards REST until a counterparty accepts, never auto-clear; a temp forward sell lists
into ALL tradable regions), and **split parcels** (`allow_split` + `min_split_quantity`, optional
`max_split_parcel_size`; partial fills, sub-min remainder auto-cancelled by the engine). The card
disclosures for both come from `preview.forward_note` / `preview.split_note`. Fees:
`get_my_fee_schedule` (data tool) returns the client's four fee cells exactly as the CRM admin
page resolves them (client agreement, else state rate card via `state_fee_structure_state`); fee
changes stay broker-mediated.

## Attachments (images & files)

Clients can attach up to 5 files per message (attach button, drag-drop, or paste): images
(png/jpg/gif/webp ≤ 5 MB) and PDFs (≤ 10 MB) reach the model as native image/document content
blocks (Agent SDK streaming input); text files (csv/tsv/txt/log/md/json/xml ≤ 256 KB) are inlined
wrapped in `<user_uploaded_file>` framing (frame-escape neutralised). Combined per-message caps
(16 MB binary / 512 KB text) keep every turn inside API limits; a user may hold at most 20 unsent
uploads. Uploads are validated by extension + magic bytes
(never the client's mime), stored as bytea in `ai_advisor.attachment` (apply
`db/attachments.sql`, or just `npm run db:init`), owner-scoped like everything else. On
fresh-session rebuilds (edit/regenerate/order events) binary attachments are re-embedded
newest-first within a 15 MB budget; older ones degrade to a named placeholder. The system prompt
(`ATTACHMENTS_HINT`) pins file content as untrusted DATA — instructions inside files are never
followed, and file content alone can never prepare an order. Design memo:
`docs/design/ai-advisor-attachments.md`.

## Dictation (live speech-to-text)

The composer has a mic button. Tap it and talk: the microphone is captured as 24 kHz PCM (an
AudioWorklet, ScriptProcessor fallback) and streamed over a websocket — `/transcribe/stream` — to the
sidecar, which relays it to OpenAI's **realtime transcription** session (**`whisper-1`** — deliberately
NOT the gpt-4o transcribe family, which follows instructions heard in the audio: "give me a summary of
my account" spoken quietly made it answer with an essay about our vocabulary prompt instead of the
transcript; whisper is a plain ASR decoder and cannot do that — override via
`AIADVISOR_TRANSCRIBE_STREAM_MODEL`), with server-side voice activity detection and the
water-vocabulary prompt bias so "megalitre", "carryover" and "inter-valley transfer" survive. Words land in the composer **per utterance, about half a second
after each pause, while the user is still talking** — nothing waits for a stop. While listening the
mic button is a live level meter (four bars driven by the microphone); tapping it again, Enter/Send,
or Escape finishes. Finishing first flushes the utterance in flight (`{type:'commit'}`) so the last
words are never lost — Send waits (spinner) for them and then the turn goes. Typing mid-dictation
re-anchors: the edit is kept and later words append after it. A session stops itself after 20 s
without speech; the sidecar caps a session at 10 min and a user at two live sockets. Auth is the same
CRM-minted bearer token, sent as the first websocket message (never in the URL). Caps and the upstream
event mapping live in `src/transcribe-stream.ts`; the key never reaches the browser (same secret
posture as the Anthropic/brokerage paths). Set `AIADVISOR_OPENAI_API_KEY` in `.env` to enable it;
when unset, `GET /me` reports `transcribe:false` and the mic button stays hidden (the websocket route
still answers, with `transcription not configured`). The hosting iframe needs `allow="microphone"`
and a secure context, and any proxy in front of the sidecar must pass websocket upgrades (see
`crm-seam/README.md`). `POST /transcribe` (whole clip in, transcript out) remains for call-notes
uploads and anything that has a finished recording rather than a live mic.
Tests: `npm run test:transcribe-stream` (offline relay + protocol; `LIVE=1` streams a fixture through
the real upstream), `npm run test:transcribe` (clip path).

## Call notes (call ends → note drafted → the CRM's Add Comment popup opens prefilled)

The CRM's Asterisk PBX bridge (`crm/pbxapp`, `/secure/pbx`) already logs every desk-phone call on the
client's account (`public.contact` rows with `phone_record=true`, `phonecall_id`,
`call_duration_seconds`) and the PBX records the audio, which the CRM already lets brokers download
(`/download-recording.html?id=`). Call notes plug into exactly that. Two halves:

1. **Pre-drafting worker** (`src/call-notes/auto.ts`): polls for logged calls that just ended (either
   direction, across all clients with a primary contact; ring-outs under
   `AIADVISOR_CALL_NOTES_AUTO_MIN_CALL_SECONDS` skipped, calls the broker already wrote up skipped),
   and for each one fetches the WAV from the PBX portal the way `ContactBo.getPhoneCall` does (two-stage
   login — the Elastix portal's session-fixation guard ignores a lone first-request POST; via
   `AIADVISOR_PBX_PROXY` where the portal whitelists caller IPs), transcribes it with speaker labels
   (`gpt-4o-transcribe-diarize`; a stereo one-leg-per-channel WAV is transcribed per channel so labels are
   exact — channels that carry the same mix (dual-mono) are detected and mixed down + diarized; long calls
   are chunked under the 25 MB / ~23 min upload limits, cuts snapped to silence, first-chunk voices handed
   to later chunks as known-speaker references. PCM WAV is fully handled; compressed WAV (GSM/WAV49,
   A/µ-law) or mp3 goes to the provider whole under `AIADVISOR_CALL_ONESHOT_MAX_BYTES` and cannot be
   split), grounds on the client (holdings and open orders through the same RLS-scoped reads as the assist
   chat; the last five CRM file notes on the primary pool, pinned to the client's account) and has the
   advisor's model draft the note **in the house style** (`src/call-notes/summarize.ts`: first person, past
   tense, the numbers said, next step, "Call back dd/mm"; strict JSON; nothing invented — unclear figures
   go to `unclear`, compliance-worthy things to `flags`, and a call that is plainly with someone else than
   the file client is flagged). The draft waits in `ai_advisor.call_note` (`db/call-notes.sql`).
2. **Prefill** (`src/call-notes/routes.ts`, `GET /assist/call-note/prefill`): the CRM's Add Comment
   popup (`registry-add-comment.jsp`, with `crm-seam/registry-add-comment-prefill.jspf` pasted in) asks
   when it opens with an empty textarea. The answer is for the logged-in broker's most recent ended,
   recorded call on that client that ended within `AIADVISOR_CALL_NOTE_PREFILL_WINDOW_MINUTES` (180) and
   has no comment by them since. `ready` → the note text (plus "Call back dd/mm" when one was agreed) goes
   into the textarea and the page's own `taCount()` runs (character counter, Service-Comment auto-tick),
   with anything to double-check (`flags` + `unclear`) shown under it — never inside the comment;
   `drafting` (worker not there yet, or a call outside its lookback — the draft starts on demand) → the
   popup polls every 2.5 s for up to 90 s with "Drafting from your call..." as the textarea placeholder;
   `none` / `failed` → the popup is just the popup. It never overwrites text (a postback brings the
   textarea back filled; typing stops the poll). The broker edits and saves the CRM's own form; **the
   sidecar never writes to the CRM** and the saved comment is indistinguishable from a typed one. The
   fill is recorded on the row (`handed_off_*`, first time only) as the audit trail.

Audio is never stored; the transcript + draft are (`AIADVISOR_CALL_NOTE_RETENTION_DAYS`, default 0 =
kept). Caps: the worker's lookback window (`AIADVISOR_CALL_NOTES_AUTO_LOOKBACK_MINUTES`, default 60 — an
outage is not backfilled, but any call still drafts on demand from the popup), a per-tick candidate cap +
in-flight concurrency, re-draft attempts on transient failures (`AIADVISOR_CALL_NOTES_AUTO_DRAFT_MAX_ATTEMPTS`,
shared by the worker and the popup), per-recording bytes, a process-wide audio memory budget, and the
rolling-24h drafting spend cap (`AIADVISOR_CALL_NOTE_DAILY_BUDGET_USD`) — over it the worker pauses and
popups stay empty; `AIADVISOR_CRM_TZ` pins the zone the CRM's naive call timestamps are read in.

Config: `src/call-notes/config.ts` — `AIADVISOR_CALL_NOTES=0` kills the feature;
`AIADVISOR_CALL_NOTES_AUTO=0` stops just the worker (popups then always wait for an on-demand draft);
`AIADVISOR_PBX_SOURCE=db|env|off` (**default off** = no PBX contact, nothing drafted; production sets
`db` = the CRM's `phone_system_settings` row, honouring its `phone_system_enabled`; env = the
`AIADVISOR_PBX_*` values — dev/test against `test/fake-pbx.ts`);
`AIADVISOR_CALL_NOTE_MODEL` (default: the advisor's model). Local dev `.env` points at the fake PBX
(`npm run callnotes:fake-pbx`); the real portal is reached only through the whitelisted proxy.
Tests: `npm run test:call-notes` (157 offline checks: WAV split/snap + dual-mono detection, transcript merge,
JSON sanitising, fake-PBX client incl. the two-stage login + retry + capped reads, store + CRM listing on the
local DB, worker candidates + retry claim + budget, the prefill decision in every state, restart sweep),
`npm run itest:call-notes` (spawns its own sidecar — `CALLNOTES_ITEST_PORT`, default :3101 — + fake PBX;
seeds ended calls, watches them pre-drafted unprompted, then calls the prefill route as the popup would,
including the on-demand path; real STT + draft, ~$1),
`npm run eval:call-notes [-- --model=…]` (grades every scripted fixture call against must-contain /
must-not-contain facts; `npm run callnotes:fixtures` renders the fixtures with TTS).

## Voice (text-to-speech + hands-free) — on every chat surface

Speech is one engine, `crm-seam/ai-voice.js`, loaded by all three chat pages — the client **AI
Advisor** tab, the broker **Client Rail** on the CRM client page, and the **AI Trainer** — so
dictation, read-aloud and voice mode behave identically everywhere. Each page enables the controls
from its own `/me` (`GET /me`, `/assist/me`, `/trainer/me` all report `transcribe` and `tts`) and
speaks over its own route (`POST /tts`, `/assist/tts`, `/trainer/tts` — the same handler behind each
surface's own admission, so the client kill switch never gates staff tooling).

- **Per-message Listen button** — each assistant reply gets a Listen action (icon-only in the
  narrow rail). It POSTs the message's markdown and plays the returned audio (`<audio>`), with a
  loading/stop state; clicking again stops. Only one message plays at a time.
- **Spoken in → spoken out** — a message dictated with the mic gets its reply read aloud as it
  streams, on every surface, with no toggle to find.
- **Voice mode toggle** (sound-wave button in the composer; its bars animate while the advisor is
  talking; all three surfaces) — hands-free conversation for a client "in a tractor, harvester or
  ute": each reply is spoken as it streams, and when playback ends the live dictation engine starts
  with auto-send — the server-side VAD ends the utterance (~0.9 s of quiet), its words land in the
  composer, and half a second later the turn is sent; the loop repeats. Tapping the mic while the
  advisor is talking interrupts the reply and listens. The loop stops on toggle-off, on a turn
  error, after 8 s with no speech, or when the tab loses visibility. On the Trainer, auto-sent
  speech is applied like any other instruction (the ledger's Undo is the safety net).

Server-side, `synthesizeSpeech` strips markdown to speech-friendly text **before** synthesis:
fenced ```` ```chart ```` blocks and pipe tables collapse to "see the chart/table on screen" (never
read cell-by-cell), fenced code becomes "see the code block on screen", links keep their anchor
text, bare URLs are dropped, emphasis/inline-code syntax is removed, and trading notation is
expanded the way a broker says it ("$95/ML" → "95 dollars a megalitre", "HS" → "high security" —
the same expander the phone channel uses). Long replies are capped at a sentence boundary and
chunked (≤ ~1800 chars/request) with the MP3 parts concatenated into one response.

**The reader — two, switchable.** Every `/me` (`/me`, `/assist/me`, `/trainer/me`) reports
`reader: 'retell' | 'openai'` and the browser engine follows it:

- **`retell` — the phone channel's own voice (`11labs-Noah`) in the browser.** Retell has no
  text-to-speech API (its only product is a call, and the Noah voice lives in Retell's private
  ElevenLabs account), but a custom-LLM agent speaks whatever text its socket hands it. So each
  spoken reply is a Retell **web call** to a dedicated *reader agent*: `POST <surface>/reader/sessions`
  creates the call, the page joins it with Retell's client SDK (loaded from jsDelivr, microphone
  muted, un-interruptible), Retell opens its custom-LLM socket to `/voice/reader/<token>/<call_id>`,
  and the page streams the reply text through `…/sessions/:id/say` as it arrives; `…/close` completes
  the response and ends the call. Text is shaped exactly as for OpenAI (markdown stripped, units
  expanded). First audio ≈ 3 s after a Listen click (call setup); for a streamed reply the call is
  opened at turn start, so it overlaps the model's first sentence. If Retell fails before it has
  spoken, that utterance is handed to the OpenAI reader and the page stays on OpenAI until reloaded
  (one toast) — words are never lost. Cost: measured **$0.096/min** exactly (Retell engine
  $0.055 + ElevenLabs voice $0.040, billed per second; no LLM charge — the "LLM" is our socket).
  The reader agent runs with post-call analysis effectively off (`gpt-4.1-nano`, no analysis
  fields): Retell's default GPT-4.1 analysis is a flat 1.5¢ per call that made short reads look
  like $0.15/min. Recorded in the ledger as `tts` / vendor `retell`; reader
  calls never become `voice_call` rows. `src/voice/reader.ts`; sessions are per user, capped
  (`AIADVISOR_READER_MAX_PER_USER` 3, `_MAX_TOTAL` 40), time out (10 min), and bound the text
  (12k chars). Switch on: `npm run voice:setup -- --reader` (creates/updates the agent — its websocket
  URL is derived from `AIADVISOR_VOICE_PUBLIC_BASE`/`_PREFIX`, so re-run it if the sidecar's public
  path changes), then `AIADVISOR_WEB_READER=retell` + `AIADVISOR_VOICE_READER_AGENT_ID` and restart.
  Needs the voice section configured (Retell key, public base, ws token). **Revert:** remove
  `AIADVISOR_WEB_READER` (or `=openai`) and restart — nothing CRM-side changes.
- **`openai` (default)** — `gpt-4o-mini-tts` on the shared dictation key, voice `ash` (its deeper
  male voice) with a style instruction asking for an understated Australian accent, so it reads like
  Noah rather than a neutral American voice. `POST /tts` per sentence group; ledger vendor `openai`.

`GET /health` shows both (`speech.tts`, `speech.reader`) and the boot log prints them. Keys never
reach the browser (same posture as `/transcribe`). Without an OpenAI key, every `/me` reports
`tts:false` and the voice controls stay hidden (dictation needs it regardless of the reader).

Env (all optional): `AIADVISOR_TTS_MODEL` (default `gpt-4o-mini-tts`), `AIADVISOR_TTS_VOICE`
(default `ash`), `AIADVISOR_TTS_INSTRUCTIONS`, `AIADVISOR_TTS_CHUNK_CHARS` (1800),
`AIADVISOR_TTS_MAX_INPUT_CHARS` (8000). Offline unit tests (markdown-stripping, unit expansion,
chunking, wire shape, a fake-provider round-trip, failure statuses): `npx tsx test-tts.ts`; the
Retell reader offline (a fake Retell drives the real socket + session routes): `npx tsx test-reader.ts`;
live routes on every surface: `npm run itest:speech`. Inbound/outbound telephony
(V1–V3) is the phone channel below ("Voice calls").

## Voice calls — inbound + outbound phone channel (Retell)

The same advisor answers and places phone calls through Retell (telephony, STT, TTS, barge-in,
recording) via its Custom-LLM websocket: `wss://<public>/voice/llm/<WS_TOKEN>/<call_id>`. Design and
contract map: `docs/design/voice-calls-design.md`. Module: `src/voice/`; schema `db/voice.sql`
(`voice_call`, `voice_call_event`, `voice_otp`, `voice_suppression`, `voice_outbound_request`).

- **Openings are code-spoken** (AI + recording disclosure; outbound adds "is now a good time?"), the
  rest of the call is the model. Persona: `personas/advisor-voice-v1.md` (spoken register, no
  markdown, one question at a time).
- **Verification tiers, enforced in the tool dispatcher** (not by prompt): tier 0 market/regulatory
  info for anyone; tier 1 (own account data) after a one-time code **or** two account facts
  (postcode / customer number / ABN / DOB / email); tier 2 (orders, withdrawals) only after the code.
  Caller-ID nominates a candidate, never verifies. No voice biometrics.
- **Orders on a call**: the existing `prepare_*` tools, then a spoken read-back (volume, zone,
  price, terms) sent with `no_interruption_allowed`, then `confirm_prepared_order` — the server
  checks the caller's actual last utterance is an unambiguous yes ("yes but change the price" is a
  no) before `confirmPendingOrder` runs through the same CRM seam as chat.
- **Escalation**: `escalate_to_broker` records the escalation + CRM `broker_action` with a summary,
  then transfers (`transfer_number`: the assigned broker's business line, else the desk fallback)
  or books a callback. Retell's custom-LLM path has no warm/whisper transfer — the CRM task is the
  "warm" context.
- **Outbound**: four flows (order_confirmation, trade_opportunity, market_alert, broker_followup);
  triggers = `POST /voice/outbound` (bearer secret, idempotency key) and the order-placed poller
  (`AIADVISOR_VOICE_OUTBOUND_ON_ORDER=1`). Every dial passes the guards: dialer kill switch,
  from-number, suppression list, calling hours (Australia/Sydney), client's advisor flag, daily
  cap. `record_do_not_call` adds the number to the suppression list on the spot.
- **Outcome logging**: Retell webhooks (`call_ended`/`call_analyzed`; HMAC signature required —
  a present-but-invalid signature is always rejected; an optional trusted egress IP is an extra
  acceptance path only when the request arrives through the loopback tunnel) close the
  `voice_call` row with transcript, recording URL, disconnection reason, outcome; every identify /
  OTP / tool / order / escalation step is a `voice_call_event`. `GET /voice/calls` (staff token:
  BROKER/SU) lists them; the outbound secret only triggers outbound calls. With
  `AIADVISOR_VOICE_ENABLED` unset every `/voice/*` route 404s except `GET /voice/health`.
- **Model backend**: `AIADVISOR_VOICE_BACKEND=api` (Messages API, needs `ANTHROPIC_API_KEY`,
  ~1 s first audio) or `sdk` (Agent SDK on host Claude Code creds — works without a key but 5–10 s
  per turn; dev only). `auto` picks api when a key exists.

Setup: `AIADVISOR_VOICE_ENABLED=1`, `RETELL_API_KEY`, `AIADVISOR_VOICE_PUBLIC_BASE` (the tunnel),
`AIADVISOR_VOICE_WS_TOKEN`, then `npm run voice:setup` (creates/updates the two Retell agents;
`-- --voices` lists voice ids, `-- --numbers` / `-- --bind +61…` once a number is imported). Browser
demo with no phone number: `AIADVISOR_VOICE_DEMO=1` + `/voice/demo`. Full env list in `.env.example`.

Tests: `npm run test:voice` (offline: phone normalisation, affirmation classifier, speech shaping,
signatures, hours, guards, reconciliation, tier gate with a scripted model),
`npm run test:voice-protocol` (a fake Retell drives the real websocket + webhook end to end with a
scripted model — identity → OTP → holdings → prepare → refused amended yes → placed via the seam →
transfer → webhook close), `npm run itest:voice` (same driver, live model).

## Projects (conversation folders)

ChatGPT-style grouping. `ai_advisor.project` is per-user and IDOR-guarded exactly like
conversations (`getOwnedProject` chokepoint); `conversation.project_id` is `ON DELETE SET NULL`,
so deleting a project keeps its chats ungrouped. Optional per-project instructions are injected
into every turn of the project's chats through the same untrusted user-preferences frame as the
global custom instructions — project scope grants them no extra authority. UI: a Projects section
in the sidebar (create / rename / instructions / delete, new-chat-in-project, expand/collapse) and
a move-to-project picker on every chat row; the header shows the open chat's project. DB-layer
test: `npm run test:projects`.

## Knowledge auto-refresh (best-by dates)

Every document and note carries an optional `best_by` frontmatter date (`YYYY-MM-DD` or `never`);
without one, an item is implicitly due once it is `KB_REFRESH_TTL_DAYS` (180) past its `as_at`.
When the date passes, a sandboxed agent (WebSearch/WebFetch only, no write tools) re-verifies the
item against its sources and returns one verdict: **confirmed** (as_at/best_by stamped forward),
**updated** (correction applied), or **flagged** (needs a human). Every applied change goes
through the trainer store — ledgered as `via='refresh'`, actor 0 ("Auto-refresh" in History),
undoable like any other change. The verbatim text of an uploaded document is never shown to the
agent and is reattached byte-for-byte, so it structurally cannot be rewritten.

Scheduling: dueness lives in the FILES, not in timers — a sidecar that was down for a month
refreshes everything due on its boot pass (45 s after listen), then every `KB_REFRESH_CHECK_MS`
(6 h). At most `KB_REFRESH_MAX_PER_TICK` (8) agent runs per pass; the rest defer to the next.
A Postgres advisory lock keeps two sidecars sharing a DB from double-running; error/flagged
attempts back off (24 h / 7 d, recorded in `kb_refresh_item`) so a broken source cannot re-run
hot. Enabled by default only where the Trainer is enabled; `KB_REFRESH=1/0` overrides.

Each run emails a digest — updated (with change numbers), needs-attention, confirmed — to every
staff account holding the AI Trainer role (`KB_REFRESH_NOTIFY_TO` replaces the list,
`_EXTRA` appends), through SMTP (`AIADVISOR_SMTP_*`; the CRM's SendGrid credentials work).
No SMTP host = console mode: the digest is logged and recorded on `kb_refresh_run`, never sent.

Tests: `npm run test:kb-refresh` (offline: policy, stamping, sandbox boundary, digest),
`npm run itest:kb-refresh` (DB + mock agent: ledger, undo, lock, backoff, cap, hash conflict),
`npm run eval:kb-refresh` (live agent: must not confirm a known-stale fact, must confirm a true
one, must not obey instructions inside the item).

## Endpoints (all require the bearer token except `/health`)

`GET /health` · `GET /me` · `GET/POST /conversations` · `GET /conversations/:id/messages` ·
`PATCH/DELETE /conversations/:id` · `GET/POST /projects` · `PATCH/DELETE /projects/:id` ·
`GET /search?q=` · `GET /conversations/:id/export?format=md|json` ·
`GET/PUT /settings` · `GET /default-questions` (the empty-chat suggestions, client audience) ·
`POST /conversations/:id/chat` (SSE) · `POST /conversations/:id/regenerate` (SSE) ·
`POST /conversations/:id/messages/:mid/edit` (SSE) · `GET /orders` ·
`POST /orders/:id/confirm` · `POST /orders/:id/cancel` ·
`POST /attachments?filename=` (raw body) · `GET /attachments/:id` · `POST /transcribe` (raw audio body) ·
`WS /transcribe/stream` (live dictation: first message `{type:'start', token}`, then PCM16 frames) ·
`POST /tts` (JSON `{text}` → audio).

**AI Trainer** (`/trainer/*`, the tool behind the CRM's **AI Trainer Home**; `TRAINER_ENABLED=1`,
caller must be staff AND hold the `AI_TRAINER` CRM role — `TRAINER_ROLE_ID` — verified from the DB per
request, fail-closed). Changes apply immediately, by the trainer AI or by hand, and every one is a
numbered ledger row (`kb_event`, full before/after text) so any change can be undone and the whole
knowledge base restored to a point in time or a named checkpoint. Changes made outside the Trainer
(git pull, a developer edit) are picked up by a startup reconcile and ledgered as `via=external`
(actor 0 = system; `TRAINER_MAINTENANCE=0` skips); `/overview` reports `counts.external_changes`,
`counts.uncommitted`, `git_commit_enabled`. Re-apply `db/trainer.sql` (`npm run db:init`) on deploy.
Routes: `GET /trainer/me|overview` ·
`GET/POST /trainer/documents`, `GET/PUT/DELETE /trainer/documents/:id` · `GET/POST /trainer/notes`,
`GET/PUT/DELETE /trainer/notes/:id` · `GET/POST /trainer/uploads`, `GET /trainer/uploads/:id[/file]`,
`POST /trainer/uploads/:id/ingest|dismiss` · `GET /trainer/reports`, `POST /trainer/reports/:id/status` ·
`GET /trainer/conversations[/:id]` (access-logged) · `GET /trainer/history[/:id]`,
`POST /trainer/history/:id/undo|restore-version`, `POST /trainer/history/batch/:id/undo` ·
`GET/POST/DELETE /trainer/checkpoints` · `POST /trainer/restore/preview`, `POST /trainer/restore` ·
`GET/PUT /trainer/default-questions` (the empty-chat suggestions per audience — broker rail / client
tab; stored in `ai_advisor.default_questions`, `db/default-questions.sql`, version-guarded saves;
no row = the built-ins in `src/default-questions.ts`) ·
`POST /trainer/chat` (SSE; emits `change` events for each applied change).
Install: `crm-seam/README.md` step 2c; role: `db/ai-trainer-role.sql`.

**Call notes** have no HTTP surface: the worker (`src/call-notes/auto.ts`) drafts and files them
server-side — see the Call notes section above. The rows live in `ai_advisor.call_note`.

## Guardrails & governance

Jailbreak resilience, tenant isolation, advice-boundary and order-manipulation defences are
documented (defence-in-depth architecture, threat model, red-team suite + results, residual risks)
in [`../../docs/design/ai-advisor-guardrails.md`](../../docs/design/ai-advisor-guardrails.md). The
adversarial suite is `test-redteam.mjs`; the persona-layer hardening lives in `src/advisor.ts`
(`HARD_PREAMBLE` + `GUARDRAILS_HINT`). The security-critical protections (tenant isolation,
order execution) are enforced in code (RLS, server-bound identity, confirm-gated brokerage), not by
the persona — see the doc's layer table.

## Security notes (v1)

- Per-user isolation is enforced at a single chokepoint (`getOwnedConversation`) — sequential ids
  are safe only because ownership is always checked.
- **Staff surfaces share one admission rule** (`staff.ts` `staffAccessDenial`): staff usertype AND
  one of the surface's CRM roles, both looked up fresh from the DB, fail-closed. Broker-assist +
  call notes: `ASSIST_ROLES` (default `BROKER,SU`, mirroring the CRM's own gate on client
  recordings); AI Trainer: `TRAINER_ROLE_ID` (`AI_TRAINER`); voice call log: BROKER/SU. An empty
  role list widens to usertype-only and is warned about at boot.
- The advisor has **no** raw DB/filesystem tools (avoids cross-tenant PII exposure). Tenant-scoped,
  read-only data grounding is a documented follow-up.
- Secrets live in `.env` (gitignored) and `${user.home}/.waterfind-ai-advisor.properties` — never in
  the CRM/SVN tree. For production prefer a real `ANTHROPIC_API_KEY` and an Apache `ProxyPass`
  (with SSE buffering disabled) so the browser calls the sidecar same-origin.
