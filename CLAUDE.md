# CLAUDE.md — Waterfind

## What this is

Working repository for **Waterfind** — an engagement for Waterfind, Australia's water-trading
exchange (a "stock market for water": ~15,000 clients, hundreds of open markets, tens of thousands
of active trade rules, ISO-9001, independently audited trust accounts, regulated across multiple
Australian state jurisdictions and the Murray–Darling Basin Plan). The goal is broker/staff tooling
and related AI capability.

## Status: greenfield — implementation undecided

**No stack, framework, language, or architecture has been chosen.** Do not assume one. Do not
scaffold an app, add dependencies, or pick a toolchain until that decision is made and recorded
here. When the approach is decided, replace this section with the real tech stack, key files, and
architecture notes (the way the other repos' CLAUDE.md files document theirs).

> An exploratory architecture analysis exists at
> `../assistants/devops-systems-engineer/analysis/` (build-vs-buy, a possible SDK-based design, and
> a red-team review). **It is reference only — not a committed plan.** We may take a completely
> different direction.

> **Full code map of the legacy CRM:** `docs/architecture/` documents the checked-out CRM
> (`crm/`) end to end — request flow, the data model, the trade-matching engine, the satellite
> services, build/config/deploy, and a step-by-step playbook for integrating a new microservice.
> Start at `docs/architecture/README.md`. (Reference; describes the *existing* code, not a chosen
> plan for this repo.)

## How to work here

These are environment conventions, not implementation rules — they hold whatever stack we pick.

- **Always use the pre-existing technology stack and code practices — exactly.** When working on or
  alongside an existing codebase (notably the **Waterfind AUS CRM**: Java 6/7, Struts/JSP, GWT,
  PostgreSQL 8.2, Apache Ant 1.8, Resin 3.1, SVN), match its stack, **exact pinned versions**, and
  conventions. Do **not** substitute newer/"nearest" versions, swap frameworks, or introduce modern
  patterns — for legacy software a mismatched JDK, database, or library version will break the build
  or runtime ("run exactly as it says, or it won't run"). Reproduce the documented setup precisely;
  if an exact dependency cannot be obtained, **flag it — never silently substitute.**
- **Branches:** never work on `main`. Use a short-lived branch (`feat/<slug>`, `fix/<slug>`,
  `chore/<slug>`, or `ai/<date>-<slug>`). One logical change per branch.
- **Never force-push `main`.** (See `.claude/settings.json` — `rm -rf` and `git reset --hard` are
  denied by default.)
- **Read before you write.** Understand the surrounding code/conventions before changing them.
- **Test before merge.** Whatever test mechanism the project adopts, run the relevant slice before
  opening a PR; PR text should cover what changed, why, how it was tested, and rollback.
- **Secrets** live in `.env` (gitignored). Copy `.env.example` → `.env`. Never commit secrets.

## Claude tooling in this repo

| Location | Purpose |
|---|---|
| `.claude/settings.json` | Shared, committed permissions (allowed tools, safe git/shell, denied destructive commands). |
| `.claude/settings.local.json` | Per-machine permission grants — **gitignored**, not shared. |
| `.claude/agents/` | Project subagent definitions (one `.md` per agent, frontmatter + system prompt). See its README. |
| `.claude/skills/` | Project skills (`<name>/SKILL.md`, optionally helper scripts). See its README. |
| `docs/design/` | Optional design memos (no longer required). |

User-level Claude tooling (global slash commands, global skills, MCP servers configured in
`~/.claude/`) is available here automatically, the same as in every other repo.

## Concurrent Claude instances

Multiple Claude instances (and the user) may edit this directory at the same time. Assume files you
read at the start of a task can change under you mid-session. Commit or stash before delegating work
that another instance might touch.
