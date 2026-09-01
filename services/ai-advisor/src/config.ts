import 'dotenv/config';

/** Parse a comma-separated CRM role list ("BROKER,SU" -> ['BROKER','SU']). */
function roleList(raw: string | undefined, fallback: string): string[] {
  return (raw ?? fallback).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
}

function int(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

function requireSecret(): string {
  const v = process.env.AIADVISOR_SHARED_SECRET;
  if (!v || v.length < 16) {
    throw new Error(
      'AIADVISOR_SHARED_SECRET is missing or too short. Set it in services/ai-advisor/.env ' +
      '(and mirror it into ${user.home}/.waterfind-ai-advisor.properties for the CRM JSP).',
    );
  }
  return v;
}

/** 'en' / 'vi' / 'auto' (case-insensitive) → normalised; anything else (or empty) → undefined. */
export function normaliseTranscribeLanguage(v: unknown): string | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'auto') return 'auto';
  return /^[a-z]{2,3}$/.test(s) ? s : undefined;
}

export const config = {
  port: int('PORT', 3100),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:81')
    .split(',').map((s) => s.trim()).filter(Boolean),
  get sharedSecret() { return requireSecret(); },
  tokenTtl: int('AIADVISOR_TOKEN_TTL', 1800),
  db: {
    host: process.env.PGHOST ?? 'localhost',
    port: int('PGPORT', 5432),
    user: process.env.PGUSER ?? 'waterfind',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'waterfind-db',
    schema: (process.env.PGSCHEMA ?? 'ai_advisor').replace(/[^a-zA-Z0-9_]/g, ''),
  },
  // Read-only, least-privilege role for the advisor's data-grounding tools (RLS-scoped).
  roDb: {
    host: process.env.PGHOST ?? 'localhost',
    port: int('PGPORT', 5432),
    user: process.env.PGRO_USER ?? 'ai_advisor_ro',
    password: process.env.PGRO_PASSWORD ?? 'ai_ro_local',
    database: process.env.PGDATABASE ?? 'waterfind-db',
  },
  // Snapshot "as of" date — the DB is a historical dump; now() finds almost no live orders.
  asof: process.env.AIADVISOR_ASOF ?? '2026-06-15',
  // Brokerage: server-to-server order-execution seam in the CRM (/ai-broker-exec.html).
  get execSecret() {
    const v = process.env.AIADVISOR_EXEC_SECRET;
    if (!v || v.length < 16) {
      throw new Error(
        'AIADVISOR_EXEC_SECRET is missing or too short. Set it in services/ai-advisor/.env ' +
        '(and mirror it as wf.ai.exec-secret in ${user.home}/.waterfind-ai-advisor.properties).',
      );
    }
    return v;
  },
  crmBase: (process.env.AIADVISOR_CRM_BASE ?? 'http://localhost:81').replace(/\/$/, ''),
  pendingOrderTtlMin: int('AIADVISOR_PENDING_ORDER_TTL_MIN', 30),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  model: process.env.AIADVISOR_MODEL ?? 'opus',
  maxTurns: int('AIADVISOR_MAX_TURNS', 12),
  turnTimeoutMs: int('AIADVISOR_TURN_TIMEOUT_MS', 180_000),

  // Haiku chat titler (port of the internal haiku naming hook): after a conversation's first
  // exchange, a small model names it asynchronously. ADVISOR_HAIKU_TITLES=0 disables.
  titlerEnabled: (process.env.ADVISOR_HAIKU_TITLES ?? '1') !== '0',
  titlerModel: process.env.ADVISOR_TITLER_MODEL ?? 'claude-haiku-4-5-20251001',
  maxConcurrencyPerUser: int('AIADVISOR_MAX_CONCURRENCY_PER_USER', 2),

  // Staff notes (AI Trainer): pinned notes ride in the advisor's system prompt and retrieve-mode
  // notes surface through search_knowledge. ADVISOR_NOTES=0 switches BOTH delivery paths off — the
  // kill switch for a bad note that is already live, without a file edit or a deploy.
  // (ADVISOR_CORRECTIONS is the pre-redesign name; still honoured.)
  notesEnabled: (process.env.ADVISOR_NOTES ?? process.env.ADVISOR_CORRECTIONS ?? '1') !== '0',
  // AI Trainer sidecar surface. Off by default; when on, a Waterfind STAFF account (broker/sales/
  // admin usertype, verified fresh from the DB, fail-closed) that ALSO holds the CRM role below is
  // admitted — see trainer/auth.ts. (CURATOR_ENABLED is the pre-redesign name; still honoured.)
  trainerEnabled: (process.env.TRAINER_ENABLED ?? process.env.CURATOR_ENABLED ?? '0') !== '0',
  // The CRM role (public.user_role.role_id) that grants the AI Trainer. "AI Trainer" is the role
  // behind the CRM's "AI Trainer Home" screen; staff get it through the CRM's own role
  // administration (Manage User Roles / the Roles button on a staff user's page). Set
  // TRAINER_ROLE_ID= (empty) to fall back to "any staff account" — kept for replicas whose
  // database lacks role assignments.
  trainerRoleId: (process.env.TRAINER_ROLE_ID ?? process.env.CURATOR_ROLE_ID ?? 'AI_TRAINER').trim().toUpperCase(),
  // Broker-assist surface (advisor embedded on the CRM client page, staff chatting ABOUT a
  // client; call notes live under it). ON by default: it is doubly gated already (staff-only JSP
  // mints the act-claim token; the sidecar re-verifies staff usertype AND role from the DB,
  // fail-closed — staff.ts staffAccessDenial). ASSIST_ENABLED=0 is the kill switch.
  assistEnabled: (process.env.ASSIST_ENABLED ?? '1') !== '0',
  // CRM roles (public.user_role.role_id, comma-separated) that admit a staff account to the assist
  // surface. Default mirrors the CRM's own gate on client recordings and the client page
  // (DownloadPhoneRecordingAction: SU or BROKER). Empty = usertype only (replicas without roles).
  assistRoles: roleList(process.env.ASSIST_ROLES, 'BROKER,SU'),
  trainerUploadMaxBytes: int('TRAINER_UPLOAD_MAX_BYTES', 32 * 1024 * 1024),
  // Each knowledge change can also be committed to git so repo history stays in step with the
  // live corpus. OPT-IN (TRAINER_GIT_COMMIT=1): the commit lands on whatever branch the checkout
  // has out, which is right for a deployment pinned to its release branch and wrong for a
  // developer's working tree (a test doc became a commit on a feature branch within a day of
  // default-on). Even when on, the trainer refuses to commit on main, in a detached HEAD or
  // mid-merge — see trainer/store.ts.
  trainerGitCommit: (process.env.TRAINER_GIT_COMMIT ?? process.env.CURATOR_GIT_COMMIT ?? '0') === '1',
  // Model for one-shot annotation of uploaded documents (title/summary/tags/key points).
  trainerAnnotateModel: process.env.TRAINER_ANNOTATE_MODEL ?? '',

  // Knowledge auto-refresh: documents and notes whose best_by date has passed are re-verified by a
  // sandboxed agent (confirmed / updated / flagged), every change ledgered as via='refresh' and
  // undoable, and each run emailed to AI Trainer role holders. Defaults to ON wherever the Trainer
  // is on (production) and OFF elsewhere (a dev sidecar must not quietly spend tokens re-verifying
  // a fresh checkout's corpus) — KB_REFRESH=1/0 overrides either way.
  get kbRefreshEnabled() { return (process.env.KB_REFRESH ?? (this.trainerEnabled ? '1' : '0')) !== '0'; },
  kbRefreshCheckMs: int('KB_REFRESH_CHECK_MS', 6 * 60 * 60 * 1000),
  // Items with no best_by are due at as_at + this many days (so the whole existing corpus is
  // covered without anyone stamping dates); best_by: never opts an item out entirely.
  kbRefreshTtlDays: int('KB_REFRESH_TTL_DAYS', 180),
  kbRefreshMaxPerTick: int('KB_REFRESH_MAX_PER_TICK', 8),
  kbRefreshModel: process.env.KB_REFRESH_MODEL || (process.env.AIADVISOR_MODEL ?? 'opus'),
  // Bounds on the next best_by the agent proposes after a refresh (days from today).
  kbRefreshMinIntervalDays: int('KB_REFRESH_MIN_INTERVAL_DAYS', 7),
  kbRefreshMaxIntervalDays: int('KB_REFRESH_MAX_INTERVAL_DAYS', 365),
  // Retry throttles, read from the latest kb_refresh_item attempt per path.
  kbRefreshErrorBackoffH: int('KB_REFRESH_ERROR_BACKOFF_H', 24),
  kbRefreshFlaggedBackoffH: int('KB_REFRESH_FLAGGED_BACKOFF_H', 7 * 24),
  // Digest recipients: everyone holding the trainer role (staff usertype, valid email). _TO
  // replaces that list outright (dev / replicas without role data); _EXTRA appends.
  kbRefreshNotifyTo: (process.env.KB_REFRESH_NOTIFY_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  kbRefreshNotifyExtra: (process.env.KB_REFRESH_NOTIFY_EXTRA ?? '').split(',').map((s) => s.trim()).filter(Boolean),

  // Outbound email (the refresh digest; anything else that later needs to mail staff). The CRM
  // sends through SendGrid SMTP — the same host/credentials work here. No host = console mode:
  // the message is logged and recorded, never sent.
  smtp: {
    host: process.env.AIADVISOR_SMTP_HOST ?? '',
    port: int('AIADVISOR_SMTP_PORT', 587),
    user: process.env.AIADVISOR_SMTP_USER ?? '',
    password: process.env.AIADVISOR_SMTP_PASSWORD ?? '',
    secure: (process.env.AIADVISOR_SMTP_SECURE ?? '0') === '1',
    from: process.env.AIADVISOR_MAIL_FROM ?? 'ai-advisor@waterfind.com.au',
  },

  // Dictation: OpenAI speech-to-text behind the composer mic button. When no key is set the
  // mic button stays hidden (the /me capability flag is false) — the rest of the advisor is
  // unaffected. Prefer AIADVISOR_OPENAI_API_KEY; fall back to the conventional OPENAI_API_KEY.
  openaiApiKey: process.env.AIADVISOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY || undefined,
  transcribeModel: process.env.AIADVISOR_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe',
  // Live-dictation language: an ISO-639-1 code pins recognition to that language; 'auto' lets the model
  // detect it per utterance (any language the user speaks lands in the composer). The browser's `start`
  // message may override this per session. Pinned to English by default: auto-detect on short, accented
  // English utterances occasionally picks another language.
  transcribeLanguage: normaliseTranscribeLanguage(process.env.AIADVISOR_TRANSCRIBE_LANGUAGE) ?? 'en',
  // OpenAI's audio endpoint hard-caps a single clip at 25 MB; dictation clips are far smaller.
  transcribeMaxBytes: int('AIADVISOR_TRANSCRIBE_MAX_BYTES', 25 * 1024 * 1024),
  // Prompt bias nudges the model toward water-market terms it would otherwise mishear. The
  // built-in jargon is always sent; AIADVISOR_TRANSCRIBE_VOCAB (site-specific extras) is appended.
  transcribeVocabulary: [
    // Brand + trade products
    'Waterfind, water allocation, water entitlement, allocation trade, entitlement trade, '
      + 'temporary trade, permanent trade, carryover, forward allocation, parking, tagged trade, '
    // Reliability classes
      + 'high-security, high-reliability water share, general-security, low-reliability water share, '
      + 'conveyance, delivery entitlement, '
    // Units
      + 'megalitre, megalitres, ML, gigalitre, GL, dollars per megalitre, '
    // Systems, zones + storages (southern connected Murray-Darling)
      + 'River Murray, Murrumbidgee, Goulburn, Campaspe, Loddon, Broken, Ovens, Lachlan, Lower Darling, '
      + 'Barmah Choke, inter-valley transfer, IVT, trade zone, Hume Dam, Dartmouth Dam, Menindee Lakes, '
    // Jurisdictions + regulatory
      + 'New South Wales, Victoria, South Australia, Murray-Darling Basin, Murray-Darling Basin Plan, '
      + 'Murray-Darling Basin Authority, MDBA, sustainable diversion limit, SDL, water sharing plan, '
      + 'allocation announcement, opening allocation, continuous accounting, '
    // Market mechanics
      + 'open market, bid, offer, order, exchange rate, tradable water',
    (process.env.AIADVISOR_TRANSCRIBE_VOCAB ?? '').trim(),
  ].filter(Boolean).join(', '),
};
