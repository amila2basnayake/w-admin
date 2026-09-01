# AI Advisor — CRM change footprint

How much of the legacy Waterfind CRM (Java 6/7, Struts/JSP, gitignored SVN checkout under `crm/`)
the AI Advisor touches. The product is the sidecar (`services/ai-advisor/`); the CRM carries only a
thin, mostly-additive integration seam. CRM-side files are tracked as reference copies under
`services/ai-advisor/crm-seam/` (chat UI + seam) and, for Java changes that cannot be git-committed
into the gitignored tree, as a patch at `docs/design/ai-advisor-flag.diff`.

Line counts are `git` add/remove. Measured 2026-07-11.

## 1. This bug-sweep session (the 2026-07-10 fixes)

Only two CRM files changed, both advisor-authored pages — no pre-existing CRM code, no Java, no
schema, no Ant rebuild.

| File | Added | Removed | What changed |
|---|---:|---:|---|
| `crm-seam/ai-broker-exec.jsp` | 198 | 39 | Idempotency map + post-placement try-split (B1/H7), confirmed-region filter (H5), `noteWritten` flag (H6), fail-closed sell-volume gate (B4) |
| `crm-seam/ai-advisor.js` | 17 | 4 | Cancel mic capture before any TTS playback — stops voice self-capture loop (H14) |
| **Total** | **215** | **43** | 2 files |

All other blocker/high fixes landed in the sidecar (TypeScript). Deploy = copy 2 files to both CRM
trees; no struts/menu/schema change, no rebuild.

## 2. Total AI Advisor CRM footprint

Split by invasiveness. Every edit to a pre-existing CRM file is a pure addition (0 lines removed).

### 2a. New, self-contained files added to the CRM (no existing logic touched)

| File | Lines | Purpose |
|---|---:|---|
| `crm-seam/ai-advisor.js` | 1314 | Chat SPA (streaming, conversations, tables/charts, order cards, attachments, voice) |
| `crm-seam/ai-broker-exec.jsp` | 662 | Server-to-server order-execution seam (HMAC, sidecar-only) |
| `crm-seam/ai-advisor.css` | 324 | SPA styles |
| `crm-seam/ai-advisor.jsp` | 272 | Chat host page + token mint/refresh |
| `action/ChangeAiAdvisorStatusAction.java` | 62 | New Struts action: broker/admin/sales toggle of the per-client flag |
| `sql/schema/REV46-.../SchemaUpdate_1.sql` | 3 | One new column (`waterfind_user.ai_advisor`, default true) |
| **Total new** | **~2637** | 6 files |

### 2b. Edits to pre-existing CRM files (the genuinely invasive footprint)

| File | Added | What |
|---|---:|---|
| `jsp/admin/registry/segments/user-reg-details.body.jsp` | 68 | Admin toggle panel for the flag |
| `business/core/WaterfindUserBo.java` | 9 | Load/save the flag |
| `core/WFContactUser.java` | 9 | Entity field + accessors |
| `dto/registryuser/RegistryUserInformationDto.java` | 9 | DTO field |
| `dto/user/UserCredentialsDto.java` | 9 | DTO field |
| `server/WaterfindDelegate.java` | 4 | Delegate method surface |
| `WEB-INF/struts-config.xml` | 4 | 2 bare forwards (`/ai-advisor`, `/ai-broker-exec`) |
| `business/admin/RegistryUserInformationBo.java` | 2 | Wire the flag through |
| `core/WFContactUser.hbm.xml` | 3 | Hibernate mapping for the column |
| `jsp/userhome/userhome.jsp` | 3 | 1 menu entry (client portal) |
| **Total edits** | **120** | 10 files, 0 removed |

So across the whole project the advisor modifies **10 pre-existing CRM files by 120 added lines,
deleting none** — mostly field/getter plumbing for one flag, two Struts forwards, and one menu
item. Everything else is new, self-contained files.

## 3. Deploy / install footprint

No Ant rebuild for the chat + seam (JSPs compile on demand). Per `crm-seam/README.md`:
copy 4 files to both CRM trees, add 2 struts forwards + 1 menu entry, apply the flag patch
(1 new action + 1 column + the plumbing above), set `wf.ai.note-author-id`, restart Resin (~2 min).

## 4. Contrast — where the code actually lives

| Area | Change vs `main` |
|---|---|
| Sidecar (`services/ai-advisor/src/*.ts`) | +3928 / -111 across 17 files |
| CRM pre-existing files (edits) | +120 / -0 across 10 files |

The CRM is an integration seam, not the product: the advisor's logic is ~97% sidecar TypeScript,
and its touch on pre-existing CRM code is ~120 additive lines with nothing deleted.
