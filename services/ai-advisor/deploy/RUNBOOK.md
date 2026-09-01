# AI Advisor — Production Runbook

Target: the Waterfind AUS CRM host (AWS EC2 Sydney, Apache -> Resin, PostgreSQL 9.6).
Shape: one Node service (`ai-advisor`) on `127.0.0.1:3100`, proxied by the existing Apache under `/ai/`,
sharing the CRM database (own schema `ai_advisor` + a read-only role). One instance only.

Sections 1-8 are in execution order. Section 0 is what we finish before handover; section 9 is what only Waterfind can fill in.

---

## 0. Before handover (White Dove)

| Item | Status |
|---|---|
| Strip dev test-order action (`TestPlaceOrderAction.java`, `userhome.jsp` Auto Buy/Sell buttons, struts entry) from the CRM diff | todo |
| Normalise `userhome.jsp` line endings so the SVN diff is ~70 lines | todo |
| `AIADVISOR_ASOF` defaults to a fixed 2026-06-15 when unset — change default to "today" for live data | todo |
| `db/grants-rls.sql` hardcodes database name `waterfind-db` and password `ai_ro_local` — parameterise | todo |
| `tsx` is a devDependency — move to `dependencies` (or ship a `tsc` build) | todo |
| Scheduler guard `AIADVISOR_PRIMARY=1` so a second instance never double-runs refresh/email jobs | todo |
| Decide `ai_advisor` flag default for prod (see 6.2) | decision |
| Rehearse this runbook top-to-bottom on a clean Ubuntu host | todo |

## 1. Prerequisites

| Need | Value |
|---|---|
| OS | Linux x86_64 (tested: Ubuntu 24.04). Amazon Linux 2023 should work; not rehearsed |
| Node | 22 LTS |
| PostgreSQL | 9.6 (the CRM DB). Superuser access once, for schema + roles |
| Apache | `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel`, `mod_rewrite` |
| Disk | 2 GB for code + `node_modules`; `knowledge/` grows slowly (MB) |
| RAM / CPU | 2 GB / 2 vCPU minimum. Load is network-bound (LLM APIs) |
| Outbound HTTPS | `api.anthropic.com`, `api.openai.com`, `api.elevenlabs.io`, `api.retellai.com`, `www.bom.gov.au`, `www.water.dcceew.nsw.gov.au`, `www.waternsw.com.au`, `www.g-mwater.com.au`, `nvrm.net.au`, `tableau.dpie.nsw.gov.au`, `smtp.sendgrid.net:587` |
| Inbound | Only via Apache (443). The service binds `127.0.0.1` |
| Egress IP | Must be whitelisted with the PBX/recording provider (call notes) |

```bash
# Node 22 (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # v22.x
```

## 2. Install

```bash
sudo useradd --system --create-home --home-dir /var/lib/ai-advisor --shell /usr/sbin/nologin aiadvisor
sudo mkdir -p /opt/waterfind && cd /opt/waterfind
sudo git clone <repo-url> waterfind && cd waterfind
sudo git checkout <release-tag>
cd services/ai-advisor
sudo npm ci                      # includes tsx (dev dep) until item in section 0 lands
sudo mkdir -p agent-workdir
sudo chown -R aiadvisor:aiadvisor /opt/waterfind/waterfind/services/ai-advisor
```

Writable paths (owned by `aiadvisor`): `knowledge/` (edited by the AI Trainer at runtime), `agent-workdir/` (agent sandbox).
Everything else can be read-only.

## 3. Configuration

```bash
sudo install -m 600 -o aiadvisor -g aiadvisor /dev/null /etc/waterfind/ai-advisor.env
sudo nano /etc/waterfind/ai-advisor.env
```

Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

| Variable | Value | Supplied by |
|---|---|---|
| `PORT` | `3100` | fixed |
| `CORS_ORIGINS` | `https://my.waterfind.com.au` (the CRM origin, comma-separated if several) | Waterfind |
| `AIADVISOR_SHARED_SECRET` | random 64-hex; must equal `wf.ai.secret` (section 6.4) | generate |
| `AIADVISOR_TOKEN_TTL` | `1800` | fixed |
| `AIADVISOR_EXEC_SECRET` | random 64-hex, different from above; must equal `wf.ai.exec-secret` | generate |
| `AIADVISOR_CRM_BASE` | `http://127.0.0.1:11000` (Resin direct) or `https://my.waterfind.com.au` | Waterfind |
| `PGHOST` / `PGPORT` | DB host / `5432` | Waterfind |
| `PGDATABASE` | `waterfind` (prod name; dev was `waterfind-db`) | Waterfind |
| `PGUSER` / `PGPASSWORD` | the CRM app role (needs write on schema `ai_advisor` only) | Waterfind |
| `PGSCHEMA` | `ai_advisor` | fixed |
| `PGRO_USER` / `PGRO_PASSWORD` | `ai_advisor_ro` / the password set in 5.2 | generate |
| `AIADVISOR_ASOF` | leave unset once the section-0 fix lands; until then set today's date daily | — |
| `ANTHROPIC_API_KEY` | Waterfind's Anthropic key | Waterfind |
| `AIADVISOR_MODEL` | `opus` | fixed |
| `AIADVISOR_OPENAI_API_KEY` | OpenAI key (dictation + read-aloud). Omit = mic hidden, nothing else changes | Waterfind |
| `TRAINER_ENABLED` | `1` | fixed |
| `TRAINER_ROLE_ID` | `AI_TRAINER` | fixed |
| `TRAINER_GIT_COMMIT` | `0` | fixed |
| `AIADVISOR_SMTP_HOST/PORT/USER/PASSWORD` | `smtp.sendgrid.net` / `587` / `apikey` / SendGrid key (post-rotation) | Waterfind |
| `AIADVISOR_MAIL_FROM` | `ai-advisor@waterfind.com.au` | Waterfind |
| `ASSIST_ENABLED` | `1` | fixed |
| `AIADVISOR_CALL_NOTES` | `1`; `AIADVISOR_PBX_SOURCE=db` (reads the CRM's `phone_system_settings`) | fixed |
| `AIADVISOR_CRM_TZ` | `Australia/Adelaide` | fixed |
| `AIADVISOR_VOICE_ENABLED` | `0` until the phone phase is deployed | fixed |
| `AIADVISOR_PRIMARY` | `1` (after section-0 item lands) | fixed |
| `NODE_ENV` | `production` | fixed |

Full reference with defaults: `services/ai-advisor/.env.example`.

## 4. Service

`/etc/systemd/system/ai-advisor.service`:

```ini
[Unit]
Description=Waterfind AI Advisor sidecar
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=aiadvisor
Group=aiadvisor
WorkingDirectory=/opt/waterfind/waterfind/services/ai-advisor
EnvironmentFile=/etc/waterfind/ai-advisor.env
Environment=HOME=/var/lib/ai-advisor
ExecStart=/opt/waterfind/waterfind/services/ai-advisor/node_modules/.bin/tsx src/server.ts
Restart=always
RestartSec=5
TimeoutStopSec=30
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/waterfind/waterfind/services/ai-advisor/knowledge /opt/waterfind/waterfind/services/ai-advisor/agent-workdir /var/lib/ai-advisor

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-advisor
sudo systemctl status ai-advisor
sudo journalctl -u ai-advisor -f
curl -s http://127.0.0.1:3100/health | head -c 300     # {"ok":true,"service":"waterfind-ai-advisor",...}
```

## 5. Database (once, as superuser)

### 5.1 Schema
```bash
cd /opt/waterfind/waterfind/services/ai-advisor
sudo -u aiadvisor bash -c 'set -a; . /etc/waterfind/ai-advisor.env; set +a; npm run db:init'
```
Runs `db/schema.sql, projects, brokerage, attachments, workflow, feedback, trainer, assist, call-notes, voice, campaigns, default-questions, kb-refresh, spend` in order. Idempotent — safe to re-run on upgrades.

### 5.2 Read-only role + RLS
```bash
sed -e 's/"waterfind-db"/"waterfind"/' -e "s/PASSWORD 'ai_ro_local'/PASSWORD '<PGRO_PASSWORD>'/" db/grants-rls.sql > /tmp/grants-rls.sql
psql -U postgres -d waterfind -f /tmp/grants-rls.sql
```
What it does: creates `ai_advisor_ro` (LOGIN, no superuser), grants SELECT on an explicit table allowlist, enables row-level security on `property`, `fees_registry_user` and the water-management tables with policies scoped to the caller's account. The CRM connects as the table owner and bypasses RLS: no CRM behaviour changes.

Verify:
```sql
-- as ai_advisor_ro, without a scoped account: must return 0
SELECT count(*) FROM property;
-- with a scope: returns only that account's rows
SELECT set_config('ai.account','<registry_user id>',false); SELECT count(*) FROM property;
```

### 5.3 CRM role + note author
```bash
psql -U postgres -d waterfind -f db/ai-trainer-role.sql     # user_role AI_TRAINER
psql -U postgres -d waterfind -f db/note-author-seed.sql    # dedicated "AI Advisor" staff user; note its id for wf.ai.note-author-id
```
Grant `AI_TRAINER` to staff via the CRM (user record -> Roles).

## 6. CRM

### 6.1 Code
Deploy SVN `branches/Iteration46` at the release revision (`r<TBD>`, based on r25481). Java changes are included, so this is a normal Ant release build, not a JSP-only drop.

| Area | Files |
|---|---|
| Java | `WFContactUser.java/.hbm.xml`, `UserRoles.java`, `WaterfindUserBo.java`, `RegistryUserInformationBo.java`, `RegistryUserInformationDto.java`, `UserCredentialsDto.java`, `WaterfindDelegate.java`, `action/ChangeAiAdvisorStatusAction.java` |
| Config | `WEB-INF/struts-config.xml` (forwards: `/ai-advisor`, `/ai-broker-exec`, `/ai-curator`, `/ai-client-advisor`, `/change-ai-advisor-status`) |
| JSP | `jsp/userhome/userhome.jsp`, `jsp/admin/registry/segments/user-reg-details.body.jsp`, `jsp/admin/registry/registry-add-comment.jsp`, `jsp/common/manager-homepage-links.jsp` |
| New pages | `jsp/userhome/app/ai-advisor.*`, `ai-broker-exec.jsp`, `ai-curator.*`, `ai-client-advisor.*`; `jsp/admin/ai-trainer-home.jsp` |

### 6.2 Migration
`sql/schema/REV46-20260707/SchemaUpdate_1.sql`:
```sql
ALTER TABLE waterfind_user ADD COLUMN ai_advisor boolean NOT NULL DEFAULT true;
```
Decision: `DEFAULT true` = every client sees the advisor immediately. For a pilot, apply with `DEFAULT false` and enable per client (client record -> AI Advisor toggle, or `UPDATE waterfind_user SET ai_advisor = true WHERE id IN (...)`).

### 6.3 Apache
Add inside the `my.waterfind.com.au` (and any other CRM host) `<VirtualHost *:443>`, before the existing `ProxyPass / http://localhost:11000/`:

```apache
# AI Advisor sidecar
ProxyPreserveHost On
ProxyTimeout 600
RewriteEngine On
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteRule ^/ai/(.*)$ ws://127.0.0.1:3100/$1 [P,L]
ProxyPass        /ai/ http://127.0.0.1:3100/ retry=0 timeout=600
ProxyPassReverse /ai/ http://127.0.0.1:3100/
```

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite
sudo apachectl configtest && sudo systemctl reload apache2     # or httpd
curl -s https://my.waterfind.com.au/ai/health | head -c 120
```

### 6.4 Properties (read by the JSPs, server side)
File: `~/.waterfind-ai-advisor.properties` in the home directory of the user Resin runs as, mode 600.

```properties
wf.ai.base-url=https://my.waterfind.com.au/ai
wf.ai.secret=<AIADVISOR_SHARED_SECRET>
wf.ai.exec-secret=<AIADVISOR_EXEC_SECRET>
wf.ai.note-author-id=<id from 5.3>
wf.ai.token-ttl=1800
```
Restart Resin after creating it. Missing file or key = the advisor page fails closed (no token, no access).

## 7. Verify

| Check | Command | Expect |
|---|---|---|
| Service up | `curl -s 127.0.0.1:3100/health` | `"ok":true`, `started_at` = last restart |
| Through Apache | `curl -s https://my.waterfind.com.au/ai/health` | same body |
| Token + identity | `TOKEN=$(npm run -s mint -- <uid> "<name>" <usertype>)` then `curl -s -H "Authorization: Bearer $TOKEN" 127.0.0.1:3100/me` | JSON with the user's identity and capability flags (`transcribe`, `tts`, `reader`) |
| Grounded answer | `npm run smoke:agent` (uses env) | a reply citing live figures, no tool errors in journal |
| Browser | log in as an enabled client -> AI Advisor tab | chat streams; mic shows only if OpenAI key set |
| Staff surfaces | staff user with `AI_TRAINER` -> AI Trainer Home; broker -> client page rail | both load |
| Isolation | section 5.2 SQL | 0 rows unscoped |
| Schedulers | `journalctl -u ai-advisor \| grep -E '\[kb-refresh\]|\[call-notes\]|refresh'` after 15 min | one tick logged, no duplicates |
| Spend ledger | `psql -c "select count(*), sum(cost_usd) from ai_advisor.spend where at > now() - interval '1 day'"` | rows after the smoke test |

## 8. Operate

| Task | How |
|---|---|
| Restart | `sudo systemctl restart ai-advisor` (in-flight chats get a stream error and retry) |
| Upgrade | `git fetch && git checkout <tag> && npm ci && npm run db:init && systemctl restart ai-advisor`. `db:init` is idempotent |
| Logs | `journalctl -u ai-advisor`; ship with the CloudWatch agent (`journald` source) |
| Alerts | `/ai/health` non-200 for 2 min; daily spend from `ai_advisor.spend` above threshold |
| Rotate a key | edit env file -> restart. Shared/exec secrets: change both the env and `~/.waterfind-ai-advisor.properties`, restart both services |
| Kill switches | `TRAINER_ENABLED=0`, `ASSIST_ENABLED=0`, `AIADVISOR_CALL_NOTES=0`, `ADVISOR_NOTES=0` (bad staff note), then restart |
| Disable for one client | client record -> AI Advisor toggle (`waterfind_user.ai_advisor`) |
| Backups | `knowledge/` nightly to S3 (`aws s3 sync knowledge/ s3://<bucket>/ai-advisor/knowledge/`); schema `ai_advisor` rides in the existing DB dump |
| Rollback | `systemctl stop ai-advisor`; comment out the Apache block; remove `~/.waterfind-ai-advisor.properties` (pages fail closed). CRM code: redeploy previous revision; the `ai_advisor` column and schema can stay |

## 9. Waterfind fills in

| Item | Owner |
|---|---|
| EC2 access / decision: same host as Resin vs sibling instance in the VPC | Amila |
| PG location (on-instance vs RDS), superuser for section 5 | Amila |
| Apache vhost edit (6.3) | Amila |
| Anthropic + OpenAI accounts and keys under Waterfind billing | Ted / Amila |
| SendGrid SMTP key (post-rotation) | Amila |
| PBX provider whitelist for the host's egress IP | Amila |
| Security group egress to the hosts in section 1 | Amila |
| CloudWatch agent config for `journald` | Amila |
| Pilot client list and the flag default (6.2) | Tom |
| Staff to hold `AI_TRAINER` | Tom |
