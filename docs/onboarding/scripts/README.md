# Onboarding helper scripts

Staged so the remaining blocked steps become one-command operations once the dependencies in
`onboarding_log.md` §6 clear. Nothing here runs automatically — each is reviewed/run by hand.

| Script | Purpose | Needs |
|---|---|---|
| `svn-checkout.sh` | Inspect repo layout, then check out the 7 projects at `Iteration45`. | `SVN_USERNAME` in `.env` + key passphrase; SlikSVN + ssh config (already set up). |
| `create-db.sql` | Create the `waterfind` owner role + an empty DB ready for `pg_restore`. | PostgreSQL running; `postgres` superuser password (in `.env`). |

After checkout, configure each project's `local-server-dev.properties` per `onboarding_log.md` §4
(Phase D), then build with Ant (`build-webapp` under `waterfind.com.au`) and run on Resin.
