# Waterfind AUS CRM — Developer Onboarding Log

> Running record of every setup step for the Waterfind AUS CRM dev environment.
> Maintained per the onboarding requirement ("record every step"). Newest-relevant
> blockers are summarized in [§6](#6-blockers--needed-from-the-user); the chronological
> record is in [§5](#5-chronological-action-log).

- **Started:** 2026-06-17 14:19 EDT
- **Machine:** Windows 10 Home 10.0.19045 (`chris`)
- **Repo (this record only):** `C:\Users\chris\src\repos\waterfind`
- **Legacy code workspace (separate, TBD):** the SVN projects are checked out into an
  Eclipse workspace *outside* this git repo — do not commit checked-out CRM source here.

---

## 1. Source documents

Three files were pulled from `~/Downloads` (the 3 most recently modified) and archived into
`docs/onboarding/source-docs/`:

| File | Type | Role |
|---|---|---|
| `How to setup AUS CRM dev environment.docx` | Word | Per-project config + build/run procedure |
| `New developer start tasks.docx` | Word | Required software, machine prep, Eclipse/SVN/Postgres setup |
| `chris.pem` | RSA private key (**encrypted**) | SSH key for SVN-over-ssh access |

Extracted plain text and embedded images are saved alongside the originals for reference.

> ⚠️ `chris.pem` is a **secret**. It currently lives in `~/Downloads` and was **not** copied
> into the repo. Per CLAUDE.md, secrets belong in `.env`/local key storage, never committed.

---

## 2. Target stack (as specified by the docs — versions are pinned)

The docs explicitly warn "new versions untested." The CRM is a legacy Java monolith:

- **Java 6** (`jdk-6u45`) and **Java 7** (`jdk-7u80`) — both required (different projects/build paths)
- **JSP + Struts** front end; **GWT** (older pages); jQuery/Bootstrap (newer pages)
- **PostgreSQL 8.2.4** (+ **pgAdmin III**)
- **Apache Ant 1.8.1** (build) ; **Resin 3.1.10** (web server)
- **SVN** over `svn+ssh` for source control; **Eclipse Oxygen 3a (4.7.3a)** as IDE
- `baretail.exe` (log viewer, optional)

**Seven SVN projects**, branch **`Iteration45`**:
`dataimport`, `datascraper`, `MyobService`, `NotificationService`, `pbxapp`,
`waterfind.com.au`, `waterfindServiceModel`.

---

## 3. Required software & system PATH (from "New developer start tasks")

Install / have ready:
`resin-3.1.10`, `apache-ant-1.8.1-bin`, `baretail.exe`, `jdk-6u45-windows-x64`,
`jdk-7u80-windows-x64`, `pgadmin3`, `postgresql-8.2.4-windows-bin`.

Add to system PATH: `resin-3.1.10`, `apache-ant-1.8.1`, `jdk-6u45-windows-x64\jdk`.

---

## 4. Consolidated setup procedure (dependency order)

This merges both documents into one ordered runbook. ☐ = not started, ⏳ = blocked, ✅ = done.

### Phase A — Tooling   (UPDATED 18:5x — real pinned legacy versions pulled into `C:\Programs`)
1. ✅ **JDK 6 + JDK 7 (real)**: Azul **Zulu OpenJDK 6** `1.6.0-119` and **Zulu 7** `1.7.0_352`
   → `C:\Programs\zulu6.22.0.3-jdk6.0.119-win_x64`, `C:\Programs\zulu7.56.0.11-ca-jdk7.0.352-win_x64`.
   (Oracle `jdk-6u45/7u80` are login-walled; Zulu are drop-in OpenJDK 6/7. Choco Temurin 8 still installed, unused.)
2. ✅ **Apache Ant 1.8.1** (exact pinned version, verified) → `C:\Programs\apache-ant-1.8.1`.
3. ✅ **Resin 3.1.10** → `C:\Programs\resin-3.1.10` (launcher `win32\resin.exe` present; matches doc's `resin.path`).
4. ✅ **Eclipse Oxygen 3a (4.7.3a)** → `C:\Programs\eclipse-oxygen-3a\eclipse\eclipse.exe` (exact doc
   version). Needed because modern Eclipse (choco 4.40) **dropped compiler compliance below 1.8** — it
   can't target Java 1.6/1.7. Use Oxygen for the build; the 4.40 install can be ignored/removed.
5. ✅ **SlikSVN 1.14.5** → `C:\Program Files\SlikSvn\bin\svn.exe` (on PATH via choco shim `…\chocolatey\bin\svn.exe`).
6. ⏳ Resin Eclipse adapter — GUI step, only relevant if Eclipse is used.
7. ✅ `baretail.exe` → `C:\Programs\baretail.exe`.
8. ⚠️ **PostgreSQL 8.2.4 binaries — could NOT be sourced** (pg.org pruned 8.2.x Windows, EDB gated, archive.org empty).
   Installed **PostgreSQL 18.4** is the working fallback; the exact 8.2.4 should come from Waterfind's bundle (§6).

### Phase B — Source checkout
8. ✅ SVN-over-SSH configured: key copied to `C:\Users\chris\.ssh\waterfind_svn.pem` (ACL-locked to user),
   `~/.ssh/config` Host entry + `%APPDATA%\Subversion\config` `[tunnels]` both point at the key.
   Host key trusted; server reachable — SSH probe returned "Permission denied (publickey)", i.e. the
   tunnel works and **only the username + key passphrase are missing**.
9. ⏳ Checkout the 7 projects, **branch `Iteration45` only** — needs username + passphrase (§6).
10. ☐ For `dataimport, MyobService, pbxapp, waterfind.com.au`: copy
    `local-server-dev.properties.sample` → `local-server-dev.properties`.

### Phase C — Database (installed PostgreSQL 18.4 — nearest to 8.2.4)
11. ✅ Cluster initialised by the EDB installer (data dir `C:\Program Files\PostgreSQL\18\data`).
12. ✅ Server running as Windows service `postgresql-x64-18` (Automatic). `psql` verifies "PostgreSQL 18.4".
13. ✅ Created role `waterfind` (LOGIN, CREATEDB). Superuser `postgres` (password in `.env`).
14. ➖ pgAdmin III not used — pgAdmin 4 ships with PG 18 if a GUI is wanted.
15. ⏳ `createdb --encoding UTF8 --owner=waterfind -U postgres "waterfind-<date>"`.
16. ⏳ `pg_restore -U waterfind -d "waterfind-<date>" -v "wf1win"` ← **requires the `wf1win` dump file**.
17. ⏳ Run `missing_tables/` SQL queries (from checked-out source).
18. ⏳ Run `sanitize_db.sql` (sanitizes data; sets all logins to password `blue49`).

### Phase D — Configure properties (Eclipse build paths + props)
19. ☐ Eclipse: Installed JREs → Java 1.7 home; compiler 1.7. Ant runtime → ant home.
    Server runtime → Resin 4.0. **Restart Eclipse after changing Java version.**
20. ☐ Build paths: for `waterfind.com.au, NotificationService, datascraper, dataimport` set
    execution env JavaSE-1.6 (jdk 1.7.0_80) and Java compiler 1.6; others default JDK 1.7.
21. ⏳ `waterfind.com.au/local-server-dev.properties`: uncomment `resin.path`; point
    `jdbc-waterfind.proxool.driver-url` at local DB; set `file.docs.path`, `file.path`,
    `file.resource.loader.path`, `waterfind.file.images*` to local workspace; set
    `waterfind.is-redundant-server=true` (suppresses outbound email/SMS — shows red banner);
    append `waterfind.taskmanager=true` + finance/email/scrape props; set
    `waterfind.server.path=http://<your-ip>`.
22. ⏳ `dataimport`: `jdbc-waterfind.driver-url=jdbc:postgresql://localhost/<db>`.
23. ⏳ `pbxapp`: set `resin.path`, DB url, `waterfind.website.secure.url=https://<your-ip>`.

### Phase E — Build & run
24. ⏳ Ant: run `build-webapp` under `waterfind.com.au` (builds everything, ~20 min).
25. ⏳ Edit Resin `resin.conf` host → `<document-directory>` = `.../waterfind.com.au/build-dev/waterfind/`.
26. ⏳ Start Resin (`resin.exe` in `resin-3.1.10\win32`).
27. ⏳ Open `http://<your-ip>:81/index.html`. Verify red redundancy banner.
28. ⏳ Test logins (password `blue49`): client `stuart@hodgefarms.com.au`, admin `kris`,
    broker `nick.sayer@waterfind.com.au`.

---

## 5. Chronological action log

### 2026-06-17 14:13–14:19 EDT — Documents
- Identified the 3 most-recent Downloads files as the onboarding set (2 `.docx` + `chris.pem`).
- Extracted text + images from both `.docx` (via `unzip` + XML strip; no Office/pandoc on machine).
- Archived originals, extracted text, and images to `docs/onboarding/source-docs/`.
- Noted `chris.pem` header: `BEGIN RSA PRIVATE KEY` / `Proc-Type: 4,ENCRYPTED` → passphrase-protected.

### 2026-06-17 14:17 EDT — Machine inventory
Compared installed tooling against §2/§3. Result — **almost nothing required is present**:

| Required | Installed on this machine | Status |
|---|---|---|
| Java 6 (jdk-6u45) | — | ❌ missing |
| Java 7 (jdk-7u80) | — | ❌ missing |
| (only JDK present) | **Temurin OpenJDK 25** | ⚠️ far too new |
| Apache Ant 1.8.1 | — | ❌ missing |
| PostgreSQL 8.2.4 + pgAdmin3 | — | ❌ missing |
| SVN client | — | ❌ missing |
| Resin 3.1.10 | — | ❌ missing |
| Eclipse Oxygen 3a | — | ❌ missing |
| Package manager | **Chocolatey 2.5.1** | ✅ available |
| SSH client | **OpenSSH 10.0p2** | ✅ available |

### 2026-06-17 14:18 EDT — External-dependency checks
- **SVN host reachable:** `svn.nowmarketservices.com` → `52.62.83.60` (AWS ap-southeast-2 / Sydney),
  responds to ping (~213 ms). Network path to the SVN server is open.
- **`chris.pem` is encrypted:** `ssh-keygen -y -f chris.pem -P ""` → "incorrect passphrase".
  Cannot be used for `svn+ssh` without the passphrase. **Need passphrase from user.**
- **Database dump `wf1win` not found** anywhere in `~/Downloads`, `~/Desktop`, `~/Documents`.
  Without it, the DB restore (step 16) is impossible. **Need the dump from user.**
- **Chocolatey only offers off-versions:** `ant 1.10.17` (need 1.8.1), `postgresql 18.4.0`
  (need 8.2.4), `Temurin8` (need Java **6 and 7**), no Resin package, no genuine Oxygen 3a.
  The pinned legacy versions are **not** a clean `choco install` away.

### 2026-06-17 14:19 EDT — Created repo artifacts
- Wrote this `onboarding_log.md` and archived source docs under `docs/onboarding/`.
- Created task list (8 tasks) tracking the phases above.

### 2026-06-17 ~18:00 EDT — User decisions
- **Toolchain:** install nearest-available versions via Chocolatey (accept "untested" caveat).
- **DB dump:** not on hand → must be requested from Waterfind; set up everything else meanwhile.
- **SVN:** "not set up yet — set it up" → install SVN client + configure repo access.

### 2026-06-17 18:00 EDT — Toolchain install (Chocolatey, elevated)
- Confirmed shell is elevated (admin) and can write to choco lib.
- `choco install sliksvn temurin8 ant -y` → success (3/3):
  - SlikSVN **1.14.5** (`svn.exe` verified), Temurin **OpenJDK 8u472**, Apache Ant **1.10.17** (verified).
- `choco install postgresql eclipse -y` → **PostgreSQL 18.4.0** + **Eclipse** (latest). PostgreSQL
  meta-package ignored the `/Password` param and **auto-generated** a superuser password — captured
  and stored in `.env` as `PGPASSWORD` (gitignored; not printed here).

### 2026-06-17 18:01 EDT — SVN-over-SSH setup
- Copied `chris.pem` → `C:\Users\chris\.ssh\waterfind_svn.pem`; `icacls /inheritance:r` + grant
  `chris:R` only (OpenSSH refuses world-readable keys on Windows).
- Wrote `C:\Users\chris\.ssh\config` (Host `svn.nowmarketservices.com`, IdentityFile, IdentitiesOnly;
  `User` is a `REPLACE_WITH_LINUX_USERNAME` placeholder).
- Wrote `%APPDATA%\Subversion\config` `[tunnels] ssh =` native Windows OpenSSH + key (fallback path).
- **SSH probe** (`ssh -i key testuser@svn... "echo ok"`): server added its ED25519 host key to
  known_hosts, then `Permission denied (publickey)`. Conclusion: DNS + network + sshd all good; the
  tunnel is wired correctly; the **only** missing inputs are the real username and the key passphrase.

### 2026-06-17 18:10 EDT — PostgreSQL up + DB role + helper scripts
- `choco install postgresql eclipse` finished 3/3: **PostgreSQL 18.4.0**, **Eclipse 4.40.0**
  (`C:\Program Files\Eclipse 4.40.0\eclipse\eclipse.exe`).
- Service `postgresql-x64-18` is **Running** (Automatic). `psql -U postgres` → "PostgreSQL 18.4".
  Superuser password (auto-generated by the package) stored in `.env`.
- Created application role **`waterfind`** (LOGIN, CREATEDB). Empty DB + `pg_restore` of `wf1win`
  wait on the dump (§6).
- Staged helper scripts under `docs/onboarding/scripts/` so the gated steps are one command each:
  `svn-checkout.sh` (lists layout + checks out the 7 projects @ Iteration45), `create-db.sql`
  (role + empty DB), `README.md`.

### 2026-06-17 18:40 EDT — SVN auth attempt (passphrase obtained)
- User supplied the key passphrase `Chris@!` → **verified**: it decrypts `waterfind_svn.pem`
  (`ssh-keygen -y` yields the 4096-bit RSA public key; fingerprint
  `SHA256:uuRlLfI8TU0r/ri47BzjlLnMl90E3OM7+mNgfg0FXvs`).
- Loaded key into ssh-agent; attempted `svn list` / `ssh -v` as users **`chris`** and **`Chris`**
  → both **`Permission denied (publickey)`**. Server is OpenSSH 6.6.1p1 (Ubuntu), **publickey-only**.
- Diagnosis: the key reaches the server and is rejected → this key's **public half is not in the
  target account's `authorized_keys`** (and/or the SSH login name is neither `chris` nor `Chris`).
  Stopped probing after a few tries to avoid a fail2ban IP block.
- Saved shareable public key to `~/.ssh/waterfind_svn.pub` for the admin to authorize.
- Stored the verified passphrase in `.env` (`SVN_KEY_PASSPHRASE`, gitignored).

### 2026-06-17 21:07 EDT — Pulled the REAL legacy binaries (per user: everything but Eclipse)
- Downloaded to `C:\Waterfind\downloads`, extracted to `C:\Programs`, all verified:
  Zulu JDK 6 (`1.6.0-119`), Zulu JDK 7 (`1.7.0_352`), Apache Ant 1.8.1, Resin 3.1.10, baretail.exe.
- Sources: Azul CDN (JDK 6/7), Apache archive (Ant), caucho.com (Resin — still live!), baremetalsoft (BareTail).
- **PostgreSQL 8.2.4 not obtainable** via any automated source (pg.org/EDB/archive.org all dead-ends).
  Left PG 18 in place as fallback; flagged 8.2.4 to come from Waterfind's bundle alongside the dump.

### 2026-06-17 21:30 EDT — Eclipse SVN attempt + Windows ssh-agent
- User tried checkout via Eclipse (Subversive); native `C:\Windows\System32\OpenSSH\ssh.exe`
  prompted for the key passphrase (expected for an encrypted PEM key with no agent — the prompt is
  NOT evidence the server accepted the key).
- Enabled the **Windows ssh-agent** service (was Disabled) and loaded `waterfind_svn.pem` into it, so
  Eclipse/native ssh no longer prompts for the passphrase.
- Re-tested `svn list` via the Windows-ssh + Windows-agent path (identical to Eclipse): still
  **`Permission denied (publickey)`**. Confirms the block is 100% server-side authorization, not a
  local Eclipse/CLI/agent/passphrase problem. Advised user to stop retrying (fail2ban risk).

### 2026-06-17 21:45 EDT — CORRECTION: exact pinned versions only (per user)
User directive: this is a legacy app — use the **exact** versions in the doc or it won't run; no
"nearest" substitutes. Re-assessed every pinned item against what's actually obtainable:

| Doc-pinned item | Exact version obtainable? | Status |
|---|---|---|
| resin-3.1.10 | ✅ caucho.com | **have (exact)** in `C:\Programs\resin-3.1.10` |
| apache-ant-1.8.1 | ✅ Apache archive | **have (exact)** in `C:\Programs\apache-ant-1.8.1` |
| baretail.exe | ✅ | **have** in `C:\Programs\baretail.exe` |
| Eclipse Oxygen 3a (4.7.3a) | ✅ archive.eclipse.org | can fetch (exact) — not yet pulled |
| pgadmin3 (1.22.2) | ✅ ftp.postgresql.org | can fetch (exact) — not yet pulled |
| **jdk-6u45-windows-x64** | ❌ Oracle login wall (302→`download-fail` page) | **must come from Waterfind / Oracle acct** |
| **jdk-7u80-windows-x64** | ❌ Oracle login wall | **must come from Waterfind / Oracle acct** |
| **postgresql-8.2.4-windows-bin** | ❌ pruned everywhere | **must come from Waterfind** |

- Stopped + disabled the wrong **PostgreSQL 18** service (frees 5432 for 8.2.4). Choco Temurin 8 /
  Ant 1.10 / Eclipse 4.40 remain installed but will NOT be used for the build (exact paths only).
- Zulu OpenJDK 6/7 pulled earlier are Java 6/7 but **not** the doc's Oracle builds — treat as a
  stopgap only; the real `jdk-6u45`/`jdk-7u80` are required.

### 2026-06-18 04:35 EDT — SVN SOLVED + all 7 projects checked out
- **Root cause of earlier failures (correcting the record):** the key + username (`chris`) were
  fine all along. The server runs **OpenSSH 6.6.1**, which only accepts legacy **`ssh-rsa` (SHA-1)**
  signatures; modern OpenSSH 9/10 disables those by default → "Permission denied (publickey)".
  Eclipse worked because **SVNKit** (pure-Java) still does SHA-1. My earlier "key not authorized"
  conclusion was wrong — it was an algorithm-compatibility wall.
- **Fix:** `PubkeyAcceptedAlgorithms=ssh-rsa` (force SHA-1), plus a `.pub` beside the encrypted key
  so ssh can match the agent key without decrypting the PEM. Verified `svn info -r HEAD` works with
  no per-command override.
- **Repo structure:** ~35 projects at the repo root, each with `trunk/ branches/ tags/`. The 7 we
  need = `<project>/branches/Iteration45`. (The eclipse-workspace copy had `Relative URL: ^/` — it
  was pulling the entire repo root, hence the mid-pull error.)
- **Checked out all 7 at rev 25467** into `crm/` (gitignored working copies + tracked `crm/README.md`):
  dataimport (33M), datascraper (42M), MyobService (5.9M), NotificationService (26M), pbxapp (28M),
  waterfind.com.au (849M), WaterfindServiceModel (37M). Note repo casing `WaterfindServiceModel`.
- **Permanent config written:** `~/.ssh/config` (User chris, encrypted key, `PubkeyAcceptedAlgorithms
  ssh-rsa`, AddKeysToAgent) + `%APPDATA%\Subversion\config` `[tunnels]`. Encrypted key loaded into the
  Windows ssh-agent. Temporary decrypted key shredded.
- ⚠️ Observed: `waterfind.com.au` bundles `webserver/resin-3.1.7a/` — the app may expect Resin 3.1.7a,
  not the doc's 3.1.10. Flag for the build phase.

### 2026-06-18 — Java 1.7 set + cleanup
- Set **User `JAVA_HOME` = Zulu JDK 7** (`C:\Programs\zulu7.56.0.11-ca-jdk7.0.352-win_x64`); User
  PATH prepended with its `\bin`. User-level overrides the machine's old Java 25 for new shells (and
  is what Ant reads). ⚠️ Machine `PATH` still lists Adoptium jdk-8/jdk-25 ahead (needs elevation to
  reorder), so a bare `java -version` in a new terminal may still show 8/25 — the *build* uses
  `JAVA_HOME`/Eclipse JRE config, so this is cosmetic.
- JDK homes for Eclipse → Installed JREs:
  - Java 1.7 (default, compiler 1.7): `C:\Programs\zulu7.56.0.11-ca-jdk7.0.352-win_x64` (`javac 1.7.0_352`)
  - Java 1.6 (for waterfind.com.au, NotificationService, datascraper, dataimport): `C:\Programs\zulu6.22.0.3-jdk6.0.119-win_x64` (`javac 1.6.0-119`)
  - (Zulu = genuine OpenJDK 6/7 standing in for Oracle jdk-6u45/7u80, which are login-walled.)
- Deleted the broken `~/eclipse-workspace/waterfind.com.au` (it was a partial pull of the entire repo
  root). `.metadata` left intact.

### 2026-06-18 — Eclipse Oxygen stood up, properties wired, build toolchain validated
- **Eclipse Oxygen 3a stood up & running**: workspace `C:\Users\chris\waterfind-workspace`, pinned to
  Java 8 in `eclipse.ini` (removed Java-9-only `--add-modules`); pre-loaded Installed JREs (Zulu 7
  default + Zulu 6) and compiler compliance 1.7 via workspace `.prefs`. **Eclipse 4.40 uninstalled**
  (the revert). Remaining GUI step: File→Import existing projects from `crm/`.
- **Properties files created** (`.sample`→`local-server-dev.properties`) for dataimport, MyobService,
  pbxapp, waterfind.com.au. Localized: previous dev's IPs (192.168.5.x) → `localhost`; DB names
  (`waterfind-paul`/`pbxapp-paul`) → `waterfind-db` **(placeholder — must match the restored dump)**;
  `resin.path` → the **bundled Resin 3.1.7a** at `crm/waterfind.com.au/webserver/resin-3.1.7a`
  (the version the code actually ships/expects — NOT the doc's 3.1.10); `is-redundant-server=true`.
- **Build toolchain validated**: Ant **1.8.1** runs on **Java 7** and parses `waterfind.com.au/build.xml`
  (target `build-webapp` present). NOTE: choco set machine `ANT_HOME`→Ant 1.10; builds MUST force
  `ANT_HOME=C:\Programs\apache-ant-1.8.1` + `JAVA_HOME=<Zulu7>` and call the 1.8.1 `ant` by full path.

### 2026-06-18 13:38 — ✅ build-webapp SUCCESSFUL
- `ant build-webapp` (Ant 1.8.1 / Java 7) → **BUILD SUCCESSFUL** in 32m36s, **zero compile errors**.
  All GWT permutations compiled + linked; Java compiled; webapp assembled.
- Artifact: `crm/waterfind.com.au/build-dev/waterfind` — `WEB-INF/classes`, **164** lib jars,
  **48** compiled GWT modules. This is the directory Resin serves (document-directory).
- Confirms the exact legacy toolchain (Zulu JDK 7, Ant 1.8.1, bundled Resin 3.1.7a refs) compiles the
  whole codebase. Remaining to *run*: a database + Resin start (below).

### 2026-06-18 20:00 — Resin configured + app RUNS up to the DB (steps 1-3 done)
- Configured `C:\Programs\resin-3.1.10\conf\resin.conf`: http **port 81**, root web-app
  `root-directory` → the built webapp `crm/waterfind.com.au/build-dev/waterfind`.
- Started Resin via `java -jar lib/resin.jar start` (3.1.10 ships only a 32-bit `win32\resin.exe`, so
  Java-launch avoids a bitness mismatch). Resin serves on `*:81`.
- **JVM-version gotcha (important):** Resin MUST run on **Java 7** (or 6), NOT 8/25. On Java 8 the app's
  2008-era Spring throws `AnnotationAwareAspectJAutoProxyCreator is only available on Java 1.5 and
  higher` (its `JdkVersion` parser doesn't recognise "1.8"). Relaunched with the full path to Zulu 7's
  `java.exe` → Spring loads cleanly (0 such errors).
- On Java 7 the webapp boots fully and reaches the **C3P0 → PostgreSQL** step:
  `jdbc:postgresql://localhost/waterfind-db` → stuck in the connect-retry loop because no DB is running.
  **This concretely proves the database is the one and only remaining blocker** — the entire exact
  legacy stack (Zulu JDK 7, Ant 1.8.1 build, Resin 3.1.10) runs end-to-end up to the DB.
- To stop Resin: `cd C:\Programs\resin-3.1.10 && <zulu7>\bin\java -jar lib\resin.jar shutdown`.
- When the DB lands: restore the dump into a database named **`waterfind-db`** (or change the property),
  start Postgres on localhost:5432, restart Resin → login page.

### 2026-06-22 — Importing db_backup (data-only dump) — schema-divergence issue
- User provided `Downloads/db_backup.zip` → `LOCAL_9_6-...-dump12.sql` (**4.5 GB**), a PostgreSQL
  **9.6.24** **`pg_dump --data-only --create`** of database `waterfind-060226`, owner `waterfind`.
  (Plain SQL; 0 CREATE TABLE — data only; uses PG15 `LOCALE=` in CREATE DATABASE, rewritten to
  `LC_COLLATE/LC_CTYPE` for 9.6.)
- Created role `waterfind` (superuser/login, pw `waterfind`) + DB `waterfind-060226`; loaded the repo
  schema `production-schema.sql` (196 tables, **0 errors**); then loaded the data with
  `session_replication_role=replica` (FK triggers off) + header `\connect`/`CREATE DATABASE` stripped.
- ⚠️ **Schema mismatch:** the live DB the data came from has **evolved past the repo snapshot** (e.g.
  data references `campaign_category.req_licence_volume`, absent from `production-schema.sql`). Matching
  tables load; changed tables fail their COPY. **For a complete/clean import we need the dump's MATCHING
  schema — a FULL dump (pg_dump WITHOUT --data-only) or a schema-only dump of the same source DB.**
- **RESULT: import FAILED.** `campaign_category` (2nd table) column mismatch desynced psql's parser; the
  remaining ~4.5 GB was mis-read as SQL (2.1M error lines; an unbalanced quote in the data made psql
  buffer a giant statement) → **`out of memory`, psql_exit=1**. Only `access_type` (10 rows of 196 tables)
  loaded. ⇒ A single column diff breaks the whole stream — pairing this data-only dump with the repo
  schema is NOT viable. **BLOCKED pending a full (schema+data) or schema-matching dump.**
- **Path A attempted (repo-reconstruct schema):** rebuilt clean DB → loaded `production-schema.sql`
  (196 tables) → applied all 228 `REV1..REV45` migration scripts in order (→ 319 tables; fixed
  `req_licence_volume`, ~758 mostly-benign "already exists" errors). **Pre-flight** (verify each of the
  dump's COPY column-lists exists): **dump has 387 tables; 274 OK / 113 mismatched** — missing TABLES
  (dispute, commodity_group, cash_float_account, finance_settings, dynamic_campaign, crop, …) AND
  missing COLUMNS on core tables (`waterfind_user.attention_note`, `registry_user.created_by_user`, …).
  ⇒ **The live DB (2026-06-19) is well ahead of the Iteration45 branch** (387 vs 319 tables). Repo can't
  supply the matching schema; core auth tables won't load → partial import wouldn't even give a login.
  **Path B (full dump) is required.** (Possible aside: the live system may be on a newer branch than
  Iteration45 — worth confirming we're building against the right branch.)
- **Searched all branches for a matching schema (2026-06-22):** `waterfind.com.au/branches` has up to
  **Iteration48** + `trunk`. Checked Iteration46/47/48 + trunk: **all share the identical stale
  196-table `production-schema.sql` and migrations only to REV46** — NONE define `dispute`,
  `commodity_group`, or `waterfind_user.attention_note`. So **no branch (incl. trunk) matches the live
  DB's 387 tables.** Root cause (per `docs/architecture/06`): the schema is **DB-sourced** —
  `generate-hbm-pojos` reverse-engineers code FROM the live DB, so tables added there never get
  forward-DDL'd into the repo, and `production-schema.sql` is a long-stale snapshot. ⇒ **The repo
  cannot supply the matching schema by any branch. A full or schema-only dump of the live DB (Path B)
  is the only option.**
- **Checked OTHER projects' SQL (2026-06-22):** CRM (Flyway: `flyway-schema/V*.sql` + `crm_update_*`),
  Billing (`flyway/` + `schema.sql`), PaymentGateway, AssetRegister, LicenceRegister, WaterValuation,
  WMS all have `sql/` dirs. Exported + searched all for the 113 missing items: only **`commodity_group`
  + `crop` (in WMS)** turned up. `dispute`, `dynamic_campaign`, `cash_float_account`, `finance_settings`,
  `broker_action`, `waterfind_user.attention_note`, `registry_user.created_by_user`, … are in **NO
  repo's SQL**. ⇒ The DB schema is a union across modules **plus runtime-generated tables** (Hibernate
  `hbm2ddl` from entity classes — no SQL artifact). Repos cannot reconstruct the full schema by any
  combination. **Confirmed: only a full / schema-only dump of the live DB will work.**
- **KEY REFRAME (2026-06-22):** checked the **504 Hibernate `.hbm.xml` mappings** in the checked-out
  projects — **none** of the 113 missing tables are mapped (vs `waterfind_user`, which IS). ⇒ the
  Iteration45 apps we actually have **never use the extra tables/columns**; they belong to the newer
  (NOW-platform) modules we didn't check out. So the reconstructed **Iteration45 schema (319 tables) IS
  sufficient to RUN our projects** — we do NOT need the full 387-table live schema or a Waterfind dump.
  The remaining mismatch is purely a *load* mechanic: to populate from the data-only dump, ADD the
  data's extra columns (as text, app ignores them) to mapped tables + create stub tables for the extra
  ones, then load → every COPY succeeds, app uses its 319 real tables. **Path A is viable after all.**
- **CORRECTION — skeptical review REJECTED Path A (2026-06-22).** My "apps never use the missing tables"
  claim was **wrong**: the `.hbm.xml` grep missed that `spring-context.xml` also loads
  `packagesToScan=com.waterfind.hibernate` — **201 JPA `@Entity` classes**. `Dispute`, `DynamicCampaign`,
  `CashFloatAccount`, `FinanceSettings`, `CommodityGroup`, `BrokerAction` all have entities; the "missing
  columns" (`waterfind_user.attention_note`, `registry_user.created_by_user`, `property.sold`=boolean)
  are in loaded `.hbm.xml`. So the app DOES use them. The all-`text` stub plan would: boot (no
  `hbm2ddl` validation anywhere → no fail-fast) then throw runtime type/SQL errors on core flows
  (disputes/campaigns/finance); a stub (`DynamicCampaign`) is even queried at STARTUP by
  `DynamicCampaignRunner`; `text` under a `boolean`/`BigDecimal` mapping corrupts typed columns; used
  tables hold FKs into stub tables; and the 228-migration replay (758 errors, 319≠387 tables) is not a
  faithful schema anyway. **VERDICT: do NOT stub-and-load. Get a vendor `pg_dump --schema-only` (or full
  dump) of `waterfind-060226` — correct by construction, ~1 min.** Also confirm which branch/revision the
  live DB matches (it's 68+ tables ahead of Iteration45 — we may be on the wrong branch).
- **MOST-RECENT-BRANCH SCAN (2026-06-22):** ranked all waterfind.com.au branches by last commit:
  **`Iteration46` = r25466, 2026-06-18** (the day BEFORE the data dump 2026-06-19) is the active line.
  Iteration48 = 2026-02, Iteration47 = 2024-12, trunk = 2023-08 (all stale). **`Iteration45` (what we
  checked out) = r25104, 2022-07-26 — ~4 years stale.** Branch number ≠ recency (46 is newer than 47/48,
  which are abandoned offshoots). ⇒ **The live DB almost certainly matches `Iteration46`; we built the
  wrong (2022) branch.** Correct setup: re-checkout/build **Iteration46** + load a dump of the live DB
  (which matches it). NOTE: `production-schema.sql` is stale in every branch (schema is DB/entity-sourced),
  so Iteration46 still needs a live-DB dump for the schema — but its CODE matches the data.
- **SWITCHED all 7 projects to Iteration46 (2026-06-22):** `svn switch` (diffs only, ~1 min), all now at
  `^/<project>/branches/Iteration46` rev 25467, **0 conflicts** (no local versioned edits to clash).
  Updated `crm/README.md` + `.env` SVN_BRANCH → Iteration46. ⚠️ Follow-ups: the `build-dev/` output is
  stale (Iteration45 build) → **rebuild** with `ant build-webapp`; re-derive `local-server-dev.properties`
  from Iteration46's `.sample` (they changed); and the data still needs a **live-DB dump matching
  Iteration46** (the reconstructed `waterfind-060226` from the Iteration45 path is now superseded).

### 2026-06-21 — PostgreSQL 9.6 moved to port 5432 + password set (DONE)
- Ran `Downloads\pg96-fix.ps1` **as admin** (this Bash shell isn't elevated; harness blocked self-elevation).
  It stopped the service, set `port=5432`, reset the `postgres` superuser password to **`password`** (via a
  temporary `pg_hba` trust window, then restored md5), restarted, and verified.
- Confirmed independently: `postgresql-x64-9.6` LISTENING on **5432**; `psql` connects with
  `postgres`/`password` → `PostgreSQL 9.6.24`. The app's jdbc url (`localhost/waterfind-db`, default 5432)
  now points at this server. **Remaining for a login page: create the `waterfind` role + `waterfind-db`
  and load `production-schema.sql` (+ plpgsql) from the repo.**

### 2026-06-21 — PostgreSQL 9.6.24 installed (installer error diagnosed + fixed via agent)
- User found `postgresql-9.6.24-1-windows-x64.exe` (EDB) but it errored on run. A diagnostic agent found
  the root cause: the bundled **VC++ 2017 redistributable** step returns **MSI 1638** ("a newer version
  is already installed" — Win10 has a newer VC++ runtime) → the EDB installer aborts. Classic EDB-on-Win10 issue.
- **Fix:** re-run unattended with **`--install_runtimes 0`** (skip the bundled redistributable). Installed clean.
- Result: **PostgreSQL 9.6.24** at `C:\Programs\PostgreSQL\9.6`, service `postgresql-x64-9.6` (Running,
  Automatic), **port 5433** (chosen to avoid the disabled PG18 on 5432). psql 9.6.24 verified.
  - ⚠️ Superuser password the agent set unattended is not recorded in `.env` — confirm or reset it.
  - ⚠️ App expects DB on **5432** (`jdbc:postgresql://localhost/waterfind-db`); 9.6 is on **5433** — either
    move 9.6 to 5432 (PG18 disabled → free) or set the app's jdbc url to `localhost:5433`.
  - Leftover `setup.exe` (the original failed GUI run) may still be open at the error dialog — can be closed.
- **Significance:** we now have a real PostgreSQL (9.6 restores 8.2 dumps far better than PG18). Combined
  with the in-repo schema (`production-schema.sql`), the app can be stood up WITHOUT Waterfind's dump.

### 2026-06-22 — ✅ FULL DATA IMPORT SUCCEEDED (Path A, entity-typed) — DB `waterfind-db` built & loaded
Work staged under `_dbwork/` (scripts, logs, DDL, split COPY files). Iteration46.
- **Properties (Iteration46):** re-derived `local-server-dev.properties` from `.sample` for dataimport,
  MyobService, pbxapp, waterfind.com.au — IPs→localhost, DB→`waterfind-db`, `resin.path`→bundled
  3.1.7a, `is-redundant-server=true`. jdbc resolves to `jdbc:postgresql://localhost/waterfind-db`.
- **Build:** first `ant build-webapp` FAILED (24 errs: monolith Iteration46 refs new datascraper classes
  `FTPBOMRainfallDataScraper`/`FTPBOMTemperatureScraper`/`MILApiDataScraper` absent from the **stale**
  `datascraper-dev.jar` built in the Iteration45 era; the `check-datascraper-built` gate skipped rebuild).
  Fix: rebuilt datascraper (`ant -Dhost=dev clean dist`), then `ant build-webapp` → **BUILD SUCCESSFUL**
  (29m25s). Artifacts in `build-dev/waterfind`: `WEB-INF/classes` + 170 lib jars.
- **DB rebuilt:** dropped `waterfind-060226` + any `waterfind-db`; created `waterfind-db`
  (OWNER=waterfind, UTF8, template0, LC_*='English_United States.1252').
- **Schema (Iteration46):** `production-schema.sql` (196 tbls, 0 err) + 237 REV migration files in
  REV/HOTFIX order (617 benign already-exists/FK-seed errors) → **313 tbls**.
- **Reconciled to data via ENTITY TYPES (not text):** dump = 387 COPY tables. Pre-flight: 261 OK,
  **95 missing tables + 31 tables missing columns**. Derived proper types from JPA `@Entity`
  (`src/com/waterfind/hibernate/*.java`, `core/**`) + `.hbm.xml` (5 parallel agents). Added **95 tables**
  + ~150 columns. ~83 ENTITY-mapped; ~14 tables had NO mapping (crop, exchange_rate, evapotranspiration_*,
  property_transfer_sale, well*, water_delivery, treasury_rate, …) → typed by data-inference (bigint/
  bool/timestamp/numeric/varchar). → **408 tbls**; all 387 dump headers satisfied.
- **Loaded (isolated, per-table COPY, `session_replication_role=replica`):** awk splitter desync'd on
  `\.` (gawk escape) → rewrote in Python → 387 well-formed per-table `.copy` files (4.3 GB). Loader does
  per-table `DELETE` (clears migration seed rows; avoids TRUNCATE FK static-check) then `\i` COPY in its
  own psql. (Lesson: never run two loaders concurrently — an early stop left an orphan COPY + a second
  loader ran without truncate → duplicate-key chaos; reset clean and ran ONE pass.)
- **Type/constraint fixes (Task 7, all entity-justified)** — recorded in `_dbwork/fix_types.sql`:
  `wateroffer.price/market_value`, `external_sales.price`, `tenderoffer.price/adjusted_price`
  bigint→double (hbm `double`); `client_ip_address.*` varchar(255)→text; `dam_reading` numeric(10,x)→
  numeric; `*charge_fee_ranges` (fees_registry_user×4, waterfind_fees, dynamic_order_details)
  bool/varchar→**integer** (hbm `int`); `property.property_user/region` & `waterfind_fees.*` DROP NOT NULL
  (real data has nulls); drop migration UNIQUE idx on `region_of_interest.(registry_user|region)`
  (real data has dups).
- **RESULT: 387/387 tables loaded; 0 mismatches. Total rows = 42,977,086 (dump expected = loaded).**
  320 tbls w/ data fully match, 67 legitimately empty. DB size **9.8 GB**. Core tables: waterfind_user
  94 606, registry_user 86 080, access_type 10, wateroffer 39 100, property 112 658. `hibernate_sequence`
  setval=1 410 824 153 (> global max id 1 410 635 055 → app `native` id-gen safe). Only 1 sequence exists
  (hibernate_sequence); app uses `<generator class="native"/>`.
- **⚠️ One run-config gap (NOT a data problem):** objects owned by `postgres`; app connects as role
  `waterfind` with **empty** password (`spring-context.xml` hibernate.connection.password blank), but
  pg_hba localhost = **md5** and the `waterfind` role's pw is `waterfind`. To run: set role pw empty
  (`ALTER ROLE waterfind PASSWORD ''`) OR put the pw in `local-server-dev.properties` OR set localhost
  pg_hba to `trust`. (`waterfind` is superuser → reads/writes postgres-owned tables fine once auth passes.)
- **⚠️ PII:** real production data incl. unsalted-MD5 password hashes; `sanitize_db.sql` (sets logins to
  `blue49`) is NOT in the checkout — DB is NOT sanitized. Data not exfiltrated anywhere.

---

## 6. Blockers — outstanding dependencies

Exact-version policy in force (per user). ✅ **SVN access RESOLVED** — all 7 projects checked out at
`Iteration45`, rev 25467, in `crm/` (§5). Remaining blockers to a *running* app:

1. **Database to RUN the app** (the one hard blocker left):
   - **`postgresql-8.2.4-windows-bin`** — confirmed NOT obtainable from any public source (official
     FTP pruned all 8.x Windows binaries → source-only; EDB 403 on every 8.2.x; archive.org / official
     Docker image: none). Must come from Waterfind, or: build 8.2.x from the (available) source, or run
     PostgreSQL 8.2 in a container (Docker 28.3.2 is installed here).
   - **`wf1win` dump** — from Waterfind (already being requested).
   - **`missing_tables` folder SQL + `sanitize_db.sql`** — post-restore scripts the doc requires; **not
     present in the SVN checkout** (only an extensive `crm/waterfind.com.au/sql/schema` tree is). Request
     these from Waterfind with the dump. (`sanitize_db.sql` is what sets all logins to `blue49`.)
   - `pgadmin3` (DB GUI) — not installed; optional (pgAdmin III 1.22.2 is downloadable; `psql` works without it).
2. **Oracle JDK 6u45 / 7u80** — login-walled, but **no longer blocking**: `build-webapp` SUCCEEDED on
   Zulu OpenJDK 7. Swap to the Oracle builds only if Waterfind insists on bit-exactness.

Have exact / self-fetchable exact: resin-3.1.10 ✓, apache-ant-1.8.1 ✓, baretail ✓,
Eclipse Oxygen 3a (fetchable), pgadmin3 1.22.2 (fetchable). Zulu JDK 6/7 = non-exact stopgap only.
⚠️ `waterfind.com.au` bundles `webserver/resin-3.1.7a/` — verify which Resin the build expects.

---

## 7. Notes & risks

- This is a **2010s-era legacy stack** (Java 6, Postgres 8.2, SVN, Resin 3.1.10, GWT). Pieces are
  EOL and vendor-gone (Caucho/Resin). Expect friction obtaining and running exact versions on
  Windows 10 in 2026.
- The setup is heavily **Eclipse-GUI-driven** (Window→Preferences, build paths, Ant view). Those
  steps need a human at the IDE or a scripted equivalent; document any deviations here.
- Hard-coded paths in the sample props reference a previous dev's machine
  (`C:/Kris/Workspaces/...`, IP `192.168.5.13`) — must be rewritten to this machine's paths/IP.
- Keep checked-out CRM source **out of this git repo**.

### 2026-06-22 — App RUNNING on Iteration46 + PermGen fix; functional testing
- App boots clean on Iteration46 against `waterfind-db` (trust auth); login page AND post-login screens
  serve HTTP 200. Login: POST `/do-login.html` (`username`+`password`); Shiro **unsalted MD5 stored as raw
  bytea** in `waterfind_user`. Test users `admin`, `nick.sayer@waterfind.com.au`, `stuart@hodgefarms.com.au`
  set to `blue49`. (`kris` doesn't exist — DB not sanitized.)
- **P0 found+fixed:** Resin JVM had `-Xmx256m` and NO `-XX:MaxPermSize` → PermGen OOM 500'd every dynamic
  screen. Added `-Xmx1024m` + `-XX:MaxPermSize=512m` + `-XX:+CMSClassUnloadingEnabled` to `resin.conf`,
  restarted → **0 PermGen during serving**; user-home/broker-home/market/crm/user-search all HTTP 200.
- **P1 (to verify at runtime):** data-inferred tables — `crop` columns text-typed (should be numeric);
  `well`/`well_reading`/`treasury_rate`/`water_delivery`/`property_transfer_sale`/`evapotranspiration_reading`
  are EMPTY → those screens likely render blank or error. Functional sweep re-running now that pages load.

### 2026-06-22 — App RUNNING + FUNCTIONALLY TESTED (Iteration46) — milestone
- **Functional sweep (~55 endpoints, all areas):** the reconstructed DB held up — **0 SQLException /
  0 "relation does not exist" / 0 errors** anywhere. Populated screens render real data correctly:
  dashboards (userhome 430KB, broker-home 259KB), market (402KB), listings (admin-expired 1.7MB;
  order_listing 108k rows), user/client detail (registry_user 86k, waterfind_user 94k, property 112k),
  weather (dam_reading 1.2M). Login works (admin/blue49).
- **2nd infra defect found+fixed:** under sweep load (cold-JSP compiles 90s+ each + huge pages) the JVM
  hit `OutOfMemoryError: Java heap space` (-Xmx1024m) and wedged. Bumped to **-Xmx2048m** in resin.conf +
  restarted → heavy screens (incl. the 1.7MB page) all 200, **0 heap OOM after boot**.
- **Remaining gap = data completeness, not bugs:** ~10 data-inferred tables are EMPTY
  (`crop, well, well_reading, water_delivery, treasury_rate, property_transfer_sale,
  evapotranspiration_reading/_station, future_order, preoffer`) → their screens render BLANK (graceful,
  not crashes). For content there, need the **real vendor data** for those tables; and when `crop` data
  lands, first `ALTER` its text columns (area/yield/age/year) to numeric.
- **VERDICT: the Iteration46 app is up and demoable** on the reconstructed 42.9M-row DB for the populated
  majority of the system. Carry-forward: data is unsanitized (real PII / unsalted-MD5) — sanitize before wider use.
