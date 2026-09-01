# CRM-side files (reference copies)

The CRM working copy (`crm/`) is SVN-managed and git-ignored, so every CRM-side file the AI
advisor needs is tracked here as the **reference copy**. The authoritative dev copies live in the
CRM trees; keep both in sync when editing.

| File | What it is |
|---|---|
| `ai-advisor.jsp` | Chat host page: reads the CRM session, mints the short-lived HMAC bearer token (fail-closed), renders the SPA. Also the token-refresh endpoint (`?token=1`). |
| `ai-voice.js` | **Speech engine shared by every chat surface** (loaded by `ai-advisor.jsp`, `ai-client-advisor.jsp`, `ai-curator.jsp` before their own script; `window.WFVoice.create({...})`). Live dictation (mic button → 24 kHz PCM over `WS /transcribe/stream` → words land in the composer per utterance while still talking; the button is a level meter while listening; Send/Enter/Escape finish, flushing the utterance in flight), read-aloud (a per-message Listen button → `POST <ttsPath>` → chunked playback that starts after the first sentence group; a dictated message gets its reply spoken back as it streams), and the optional hands-free voice mode (speaks each reply as it streams, then listens with auto-send). Each host passes its own composer elements, token flow and TTS/reader routes (`/tts` + `/reader`, `/assist/tts` + `/assist/reader`, `/trainer/tts` + `/trainer/reader`) and enables the two capabilities from its `/me` flags. Two readers: `openai` (POST tts → `<audio>` queue) and `retell` (the phone channel's voice: one Retell web call per utterance via Retell's browser SDK from jsDelivr, mic muted, text streamed through the sidecar; falls back to OpenAI if Retell fails before it speaks) — `/me.reader` says which, driven by the sidecar's `AIADVISOR_WEB_READER`. |
| `ai-voice.css` | The engine's controls: mic states/level meter, voice-mode wave, Listen button — host-token colours with neutral fallbacks. |
| `ai-advisor.js` | The chat SPA: streaming, conversations, projects (ChatGPT-style folders: grouped sidebar, per-project instructions, move-to-project), markdown + tables + `chart` blocks (inline SVG with hover/table view), order confirmation cards, system-note bubbles, per-tool activity labels, attachments (attach button / drag-drop / paste, chips + authed thumbnails), and speech via `ai-voice.js` (mic, Listen, voice mode). |
| `ai-advisor.css` | SPA styles, light/dark themes, chart/card styling. |
| `ai-broker-exec.jsp` | Server-to-server order-execution seam (HMAC-authenticated, sidecar-only). Places/withdraws orders through the Spring-proxied `WaterfindDelegate`, re-validating scope against the CRM's own licence enumeration. After a successful action it also writes a plain-text CRM Contact Note onto the client's account (via `WaterfindDelegate.addClientNote`, best-effort, `clientService=false`). Also carries `op:"optout"` (a client told the phone assistant not to call): writes the Contact Note and switches "Include in Campaigns" off through `WaterfindDelegate.updateUserSettings` (only the campaign flag is set on the DTO; other settings untouched), idempotency-keyed per call. See `docs/design/ai-brokerage.md`. |
| `ai-curator.jsp` | **AI Trainer** host page (file name kept for the existing struts forward `/ai-curator.html`) — the tool behind **AI Trainer Home**: same token minting as `ai-advisor.jsp`, refuses definitive client accounts, otherwise defers to the sidecar's fail-closed DB check (staff usertype AND the `AI_TRAINER` CRM role) on `/trainer/*`. Token refresh at `?token=1`. Embedded by `ai-trainer-home.jsp`; also openable directly. Loads IBM Plex from Google Fonts (falls back to Segoe UI). |
| `ai-trainer-home.jsp` | **AI Trainer Home** — a CRM staff home page in the `marketing-home.jsp` / `ceo-home.jsp` family (CRM chrome, the manager home-page tab strip, `normal_header` band). Installed at `jsp/admin/`, served at `/ai-trainer-home.html`. Renders the Knowledge Curator (`/ai-curator.html` in a viewport-sized iframe) for holders of the `AI_TRAINER` role via `WaterfindDelegate.hasAccess(UserRoles.ROLE_AI_TRAINER, uid)` (fresh per request); anyone else sees an "AI Trainer role required" panel. |
| `ai-trainer-home.crm.patch` | `svn diff` of the two CRM files the home page changes: `jsp/common/manager-homepage-links.jsp` (adds the "AI Trainer Home" tab, `pageIndex 7`, and adds `showAiTrainer` — plus the previously missing `showMarketingTeam` — to the strip's outer guard) and `src/com/waterfind/business/user/UserRoles.java` (`ROLE_AI_TRAINER = "AI_TRAINER"`). |
| `ai-client-advisor.jsp` | Broker-assist rail host page (staff-only), loaded in the rail iframe on the CRM client page as `/ai-client-advisor.html?clientId=<waterfind_user.id>`. Staff-gated like the curator; resolves the viewed client server-side and mints the bearer token with a signed `act`/`actName` claim binding it to that client (the URL param is never the scoping mechanism). The sidecar's `/assist` routes require the claim AND re-verify the caller's staff usertype from the DB, fail-closed. Token refresh at `?token=1&clientId=N` (JSON `{token, exp, base}` — `base` is the sidecar URL; the Add Comment prefill script gets its token and base from here). `&popout=1` renders the standalone-window variant. |
| `registry-add-comment-prefill.jspf` | Call-note prefill for the CRM's **Add Comment** popup (`jsp/admin/registry/registry-add-comment.jsp`, pasted in after the `#note` textarea's Escape-key script by `deploy-client-rail.mjs`). Plain JS, no server-side change: when the popup opens with an empty textarea it fetches a token same-origin (`/ai-client-advisor.html?token=1&clientId=<selectedUser.userId>`), asks `GET <base>/assist/call-note/prefill`, and on `ready` fills `#note` with the drafted note and runs the page's `taCount()`; on `drafting` it polls (placeholder "Drafting from your call...") for up to 90 s; anything else leaves the popup untouched. Never overwrites text (postback or typing). `flags`/`unclear` appear as a "Check:" line under the textarea, never in the comment. ASCII only (ISO-8859-1 JSP). |
| `ai-client-advisor.js` | Rail panel SPA ("Client Rail"): per-client shared staff chat history (history dropdown, staff attribution), SSE streaming, markdown + tables + `chart` blocks (same renderer as `ai-advisor.js`), third-person tool activity labels, composer with client-scoped placeholder. The history dropdown also lists the CLIENT's own advisor chats, opened read-only (composer hidden, messages attributed to the client; every transcript read is access-logged server-side in `assist_transcript_access`). Order confirmation cards (the advisor stages an order for the client; the broker ticks the client-instructed/T&C box and confirms — `/assist/orders`); no attachments/projects. Draft + open-conversation survive the CRM's full-page postbacks via `sessionStorage`. Close/width-cycle/pop-out buttons message the parent page via `postMessage`. Speech via `ai-voice.js`: mic dictation, an icon Listen button on each reply, and voice mode — over `/assist/tts` and the shared dictation websocket, hidden unless `/assist/me` reports `transcribe` / `tts`. (Call notes are not in this UI — they arrive in the CRM's own Add Comment popup; see `registry-add-comment-prefill.jspf`.) |
| `ai-client-advisor.css` | Rail panel styles: CRM black-gradient client header (`#FFF380` name), light theme, chart/table styles at 400px rail width. |
| `ai-client-advisor-embed.jspf` | The embed block appended to the END of `jsp/admin/registry/segments/user-reg-details.body.jsp` (both trees): right-edge "AI Advisor" launcher tab (joins the existing Market Data / Survey tab stack), the fixed rail + lazy iframe appended to `document.body` (never inside `#market_section`, which clips), `body.wfai-open` page shift, Survey-drawer close on open, Alt+A / Esc, width cycle (340/400/560), pop-out window, `document.title` fix, sessionStorage reopen across postbacks. Also inserts an **inline tile** (side-by-side trial vs the rail): the same panel in a fieldset directly after Contact Notes, `&popout=1` (hides rail-only chrome), iframe src set lazily on first scroll-into-view. Plain DOM JS — no jQuery dependency. |
| `ai-curator.js` | AI Trainer SPA: assistant rail (left; SSE chat with the trainer agent, tool-activity chips, inline **change cards** № N with Undo, attach uploads to a message, conversation survives CRM reloads via `sessionStorage`; speech via `ai-voice.js` — mic dictation, a Listen button under each reply and hands-free voice mode, over `/trainer/tts`) + workspace tabs — **Library** (overview tiles; regulatory + library documents, filters, search; read view; structured editor for details + markdown body; Delete; per-document change list with restore-a-version), **Notes** (agnostic staff notes, pin/retrieve, inline add/edit, pin meter), **Questions** (the default questions offered on an empty new chat — two lists: Brokers = the Client Rail, Clients = the AI Advisor tab; add/edit/reorder/remove, one Save for both, version-guarded 409 on a concurrent save, "built-in defaults" until a list is first saved), **Uploads** (drop zone; PDF/DOCX/text extracted on arrival in a worker thread, 60 s cap; "Add to library" annotates + keeps the original; "in the library" is derived from the corpus, so a deleted/undone document re-enables "Add to library"; discuss in chat; "Open file" only when this host holds the bytes — `knowledge/uploads/` is gitignored, the library document carries the full text), **Reports** (advisor users' inaccuracy reports with the disputed exchange, resolve/dismiss; find any conversation — searches AND reads are access-logged), **History** (the ledger: every change with who/how/when, What-changed diff, Undo; restore batches; between-row "restore everything to just after № N" seams; checkpoints; restore to a date-time with preview then confirm — a restore is bound to its preview (`expect_head`/`expect_changes`) and answers 409 if the log moved; "outside the Trainer" rows are what the startup reconcile found changed on disk (deploy/edit), "baseline" rows the files as first seen). Everything the assistant does can be done by hand here; both are ledgered identically. Oversized uploads/bodies come back as JSON 413 with the limit. |
| `ai-curator.css` | AI Trainer styles (deep-water rail + paper workspace, IBM Plex, numbered change chips; tightens for the ~960px CRM embed). |
| `ai-campaigns-home.jsp` | **Call Campaigns** — a CRM staff home page in the same family as `ai-trainer-home.jsp` (CRM chrome, manager tab strip `pageIndex 8`). Installed at `jsp/admin/`, served at `/ai-campaigns-home.html`; renders the tool (`/ai-campaigns.html` in a viewport-sized iframe) for holders of the `BROKER` or `SU` role via `hasAccess()` (fresh per request). |
| `ai-campaigns.jsp` | Call Campaigns host page (`/ai-campaigns.html`): same token minting as `ai-curator.jsp`; the sidecar's `/voice/campaigns/*` routes apply the fail-closed DB check (staff usertype AND one of `ASSIST_ROLES`, default `BROKER,SU` — the voice-admin rule). Token refresh at `?token=1`. |
| `ai-campaigns.js` | Call Campaigns SPA: campaigns down the left (status, flow, progress bar); the selected campaign on the right — **Brief** (call type = `trade_opportunity` / `market_alert` / `broker_followup`, message, broker, region, callback number from the allowlist, start now / at a time, calls-at-once, the fixed opening line the assistant will speak) and **Call list** (each client's live state: waiting / queued / calling / called / voicemail / failed / suppressed / skipped-with-reason / cancelled; click a called row for the summary + recording link). **Add clients** sheet: filters over the CRM's accounts (search by name/company/email/id/CRN, state/authority → zone, broker, minimum ML held, not contacted since) with one row per account (its primary contact), flags for suppressed / advisor off / opted out; or paste client ids / CRNs. Launch / Pause / Resume / Cancel / Delete / Duplicate; edits autosave; polls every 8 s while running. Top bar shows dialer armed/off and the calling window. |
| `ai-campaigns.css` | Call Campaigns styles (paper workspace, IBM Plex; tightens for the ~960px CRM embed). |
| `deploy-campaigns.mjs` | Copies the four Call Campaigns files into both CRM trees, inserts the two struts actions and the tab-strip hunk when missing (keeps the checkout's CRLF). Idempotent. |
| `deploy-speech.mjs` | Copies the shared speech engine (`ai-voice.js/.css`) and every page that loads it (advisor, trainer, client rail: jsp/js/css) plus `ai-trainer-home.jsp` (iframe `allow="microphone"`) into both CRM trees. Idempotent; no restart. |

## Install (no Ant rebuild — JSPs + four struts forwards + one menu entry)

1. Copy `ai-voice.js`, `ai-voice.css`, `ai-advisor.jsp`, `ai-advisor.js`, `ai-advisor.css`, `ai-broker-exec.jsp`, `ai-curator.jsp`,
   `ai-curator.js`, `ai-curator.css`, `ai-client-advisor.jsp`, `ai-client-advisor.js`,
   `ai-client-advisor.css` to **both** CRM trees (`ai-trainer-home.jsp` goes to `jsp/admin/` — step 2c;
   `node services/ai-advisor/crm-seam/deploy-speech.mjs` copies all of these except `ai-broker-exec.jsp`):
   - `crm/waterfind.com.au/webapp/jsp/userhome/app/` (source)
   - `crm/waterfind.com.au/build-dev/waterfind/jsp/userhome/app/` (served by Resin)
2. Add four bare forwards to `WEB-INF/struts-config.xml` in both trees (near the other userhome forwards):
   ```xml
   <!-- AI Water Advisor chat page (mints the sidecar bearer token from the CRM session) -->
   <action path="/ai-advisor" forward="/jsp/userhome/app/ai-advisor.jsp"/>
   <!-- server-to-server order-execution seam for the AI advisor sidecar (HMAC-authenticated; see the JSP) -->
   <action path="/ai-broker-exec" forward="/jsp/userhome/app/ai-broker-exec.jsp"/>
   <!-- AI Trainer (staff-only; sidecar verifies staff usertype + the AI_TRAINER role from the DB, fail-closed) -->
   <action path="/ai-curator" forward="/jsp/userhome/app/ai-curator.jsp"/>
   <!-- Broker-assist advisor rail on the CRM client page (staff-only; the sidecar re-verifies staff usertype from the DB, fail-closed) -->
   <action path="/ai-client-advisor" forward="/jsp/userhome/app/ai-client-advisor.jsp"/>
   ```
   The trainer has **no client-portal menu entry on purpose** — it is a staff tool, reached from
   **AI Trainer Home** (step 2c) or by opening `/ai-curator.html` directly. Access needs
   `TRAINER_ENABLED=1` (or the older `CURATOR_ENABLED=1`) in the sidecar `.env`, a staff account (broker/sales/admin usertype) AND the
   `AI_TRAINER` CRM role (`TRAINER_ROLE_ID`, default `AI_TRAINER`) — clients, external authorities,
   press, and staff without the role are refused by the sidecar's DB check.
2c. **AI Trainer Home** (the CRM home screen for the role — sits beside Sales Manager Home /
   Marketing Home / Executive Home). Four pieces, then a Resin restart:
   1. **The role.** `psql -h localhost -U waterfind -d waterfind-db -f services/ai-advisor/db/ai-trainer-role.sql`
      creates `user_role` row `AI_TRAINER` / "AI Trainer" (idempotent; or create it in the CRM:
      Admin Home → Waterfind Admin → Manage User Roles). Then grant it per staff user in the CRM —
      the **Roles** button on the staff user's record (`/admin-view-registry-user-details.html`,
      superuser / ASSIGN_ROLES) — or with the commented `user_role_map` insert in that script.
   2. **`UserRoles.ROLE_AI_TRAINER`.** Apply `ai-trainer-home.crm.patch` (adds the constant to
      `src/com/waterfind/business/user/UserRoles.java`), then either Ant-rebuild, or compile that
      one dependency-free class exactly as the build does and drop it into the served classes dir:
      ```bash
      "$JDK7/bin/javac.exe" -source 1.6 -target 1.6 -g -encoding UTF-8 \
        -d build-dev/waterfind/WEB-INF/classes src/com/waterfind/business/user/UserRoles.java
      ```
      (The JSPs reference the constant; Resin's JSP compiler needs the class to have it.)
   3. **The pages.** Copy `ai-trainer-home.jsp` to `jsp/admin/` in **both** trees; apply the
      `manager-homepage-links.jsp` hunk of `ai-trainer-home.crm.patch` (both trees) — it adds the
      "AI Trainer Home" tab (shown to `AI_TRAINER` holders only — deliberately not the executive
      catch-all, since this is a write surface for what the advisor tells clients) and also fixes
      the strip's outer guard, which was missing `showMarketingTeam`.
   4. **The struts action** (both trees, next to `/ceo-home`):
      ```xml
      <action path="/ai-trainer-home" type="com.waterfind.user.CheckSalesAdminLoggedInAction">
          <forward name="success" path="/jsp/admin/ai-trainer-home.jsp"/>
          <forward name="failure" path="/login.html?nextPage=/ai-trainer-home.html"/>
      </action>
      ```
      `CheckSalesAdminLoggedInAction` admits staff (sales or admin) like `/sales-manager-home`; the
      JSP then gates the tool on the role. Restart Resin (step 5).
2b. **Broker-assist rail:** append the contents of `ai-client-advisor-embed.jspf` to the END of
   `jsp/admin/registry/segments/user-reg-details.body.jsp` in **both** trees. No menu entry — the
   launcher is the right-edge "AI Advisor" tab on every client page. The sidecar surface is ON by
   default (`ASSIST_ENABLED=0` is the kill switch) and needs no roster: any staff account is
   admitted after the DB usertype check; the client's own `ai_advisor` flag does NOT gate this
   staff surface. Orders: the broker can place and withdraw for the client from the rail — the
   advisor stages a card, the broker ticks "the client has instructed this order" and confirms
   (`/assist/orders/:id/confirm`, staff token), and the order lands on the CLIENT's account through
   the same seam, recorded on the row, the CRM contact note ("Placed by <staff> (Waterfind staff)
   for the client") and the broker task. Only the escalate-to-a-broker tools are stripped for
   `/assist` turns. Deploy the seam JSP alongside (`ai-broker-exec.jsp`, both trees) for the note text.
2e. **Call Campaigns** (outbound AI calls to a client list): `node services/ai-advisor/crm-seam/deploy-campaigns.mjs`
   from the repo root does everything CRM-side for both trees — the four files, the struts actions
   (`/ai-campaigns-home` via `CheckSalesAdminLoggedInAction` → `jsp/admin/ai-campaigns-home.jsp`, and the
   bare forward `/ai-campaigns` → `jsp/userhome/app/ai-campaigns.jsp`) and the "Call Campaigns" tab in
   `manager-homepage-links.jsp` (shown to BROKER / SU holders). Restart Resin once for the actions. No new
   CRM role or Java change. Sidecar side: `psql … -f services/ai-advisor/db/campaigns.sql` (two
   `ai_advisor` tables plus ONE index on the CRM's `public.property(registry_user)` — the list builder
   aggregates licences per account and the CRM has no such index), `AIADVISOR_VOICE_ENABLED=1` (the
   page lives under `/voice`), and the dialer switches as documented in `.env.example`
   (`AIADVISOR_VOICE_OUTBOUND_ENABLED`, `AIADVISOR_VOICE_FROM_NUMBER`). With the dialer off, launched
   campaigns queue and the page says "Dialer off". Eligibility honours the CRM's own
   `registry_user.campaign_optin` ("include in campaigns") and `waterfind_user.ai_advisor` flags, the
   suppression list, and phone-on-file; the dialer's guards (calling hours, daily cap, suppression)
   still apply at dial time.
2d. **Call notes** — the Add Comment popup opens prefilled with the AI-drafted note for the call the
   broker just had. One CRM piece: `registry-add-comment-prefill.jspf` pasted into
   `jsp/admin/registry/registry-add-comment.jsp` (both trees) directly after the `#note` textarea's
   inline Escape-key `<script>` — `node services/ai-advisor/crm-seam/deploy-client-rail.mjs` does
   this (and copies `ai-client-advisor.jsp`, whose `?token=1` JSON the script relies on). No struts
   change, no restart. The sidecar never writes to the CRM: the broker saves the CRM's own form.
   Sidecar side: set `AIADVISOR_PBX_SOURCE=db` in production — it reads the PBX portal URL/credentials from the CRM's
   own `phone_system_settings` row — the same values `ContactBo.getPhoneCall` uses for the CRM's
   recording download link — so production needs no new secret; the OpenAI key is what
   turns the feature on (`AIADVISOR_PBX_PROXY` if the portal whitelists caller IPs). In dev use
   `AIADVISOR_PBX_SOURCE=env` + `npm run callnotes:fake-pbx` so the real portal is never contacted.
   `AIADVISOR_CALL_NOTES=0` switches it off (the popup's request 404s and it stays plain).
3. Add the menu entry to `jsp/userhome/userhome.jsp` in both trees (client portal, WATER MANAGEMENT MENU):
   - one `<li>` link: `<a href="#" data-url="true" data-menu-id="ai-advisor" data-page-name="AI Advisor">` with a
     `fa-comments` icon, after "Site Budget";
   - `'ai-advisor': '/ai-advisor.html'` in **both** branches of the `menuUrls` map (~lines 503/512).
   - **Dictation + voice mode:** the content `<iframe>` that hosts `/ai-advisor.html` must carry
     `allow="microphone"` (Permissions-Policy) or `getUserMedia` is blocked inside the frame and the
     mic button (and voice mode's auto-listen) silently no-op. Add the attribute to that iframe
     element. The page must also be a **secure context** — HTTPS in any real deployment;
     `localhost`/`127.0.0.1` is exempt in dev. Voice **playback** (`/tts`) needs no extra iframe
     permission — the first play is triggered by the user's toggle/tap gesture, and audio thereafter
     runs in the same activated document. If the OpenAI key is unset in the sidecar, `GET /me`
     reports `transcribe:false` / `tts:false` and both the mic and the voice controls stay hidden —
     this step is a no-op then, so it is safe to add unconditionally.
   - **Live dictation is a websocket** (`ws(s)://<wf.ai.base-url>/transcribe/stream`, derived from the
     same `wf.ai.base-url`): any reverse proxy in front of the sidecar (the Caddy block on the public
     tunnel, a corporate proxy) must pass HTTP upgrades on that path. Caddy's `reverse_proxy` does so
     by default; a proxy that does not will make the mic button show "Dictation unavailable".
4. Create `${user.home}/.waterfind-ai-advisor.properties` (outside both repos — never committed):
   ```properties
   wf.ai.secret=<64-hex>        # browser-token secret  = AIADVISOR_SHARED_SECRET in the sidecar .env
   wf.ai.exec-secret=<64-hex>   # order-exec secret     = AIADVISOR_EXEC_SECRET   in the sidecar .env  (distinct value)
   wf.ai.base-url=http://localhost:3100
   wf.ai.token-ttl=1800
   wf.ai.note-author-id=<id>    # waterfind_user.id that authors the post-trade CRM Contact Note.
                                # Provision it once with services/ai-advisor/db/note-author-seed.sql
                                # (prints the id). Read SERVER-SIDE only — never from the signed
                                # request — so the sidecar cannot choose the author. If unset the
                                # trade still executes; only the note is skipped.
   ```
5. Restart Resin (struts-config reload): `java -jar lib/resin.jar shutdown && ... start` (~2 min).
   JSP edits alone hot-compile on next hit — no restart needed.

## Post-trade CRM note write-back (requires an Ant rebuild — not JSP-only)

After a successful place/withdraw, `ai-broker-exec.jsp` records a plain-text Contact Note on the
client's account — the same notes the admin client page shows — authored by a dedicated "AI
Advisor" CRM user, `clientService=false` (so it is not counted as a broker service contact). The
note text is composed server-side from the trade values (no HTML, no model-authored text).

Unlike the rest of this seam, this depends on a new CRM Java method,
`WaterfindDelegate.addClientNote(authorUserId, clientId, accountId, note)`, so the JSP will **not**
compile against a build that lacks it. Deploy in this order:

1. Add `addClientNote(...)` to `src/com/waterfind/server/WaterfindDelegate.java` (wraps
   `commentBo.addComment(...)`; validates the signed `accountId` is the acting client's own
   registry account before writing) and **Ant-rebuild** the CRM so the compiled class ships to the
   Resin-served tree (`build-dev/waterfind/WEB-INF/classes`).
2. Only then copy the updated `ai-broker-exec.jsp` into the served `build-dev` tree. Copying the
   note-writing JSP ahead of the rebuilt class makes Resin's hot-compile fail (`cannot find symbol
   addClientNote`) and breaks the seam.
3. Provision the author user once and set its id:
   ```bash
   psql -h localhost -U waterfind -d waterfind-db -f services/ai-advisor/db/note-author-seed.sql
   # copy the printed id into wf.ai.note-author-id in ~/.waterfind-ai-advisor.properties
   ```

The sidecar adds the acting client's `accountId` to the signed body (`services/ai-advisor/src/brokerage.ts`);
the author id is read only from `wf.ai.note-author-id`, never the request, so the sidecar can never
choose who a note is attributed to. If the property is unset or the account does not resolve to the
client, the note is skipped and logged — the trade is never affected.

Design, trust model and the mirrored scope rules: `docs/design/water-advisor-chat.md` and
`docs/design/ai-brokerage.md`.
