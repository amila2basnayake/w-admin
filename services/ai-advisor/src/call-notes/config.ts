/**
 * Call notes — configuration. Self-contained (env read here, not in config.ts) so the feature
 * adds nothing to the shared config surface; the OpenAI + Anthropic keys and the advisor model
 * are still taken from the shared config so ONE credential set drives everything.
 *
 * What the feature does: after a broker's desk-phone call with a client (which the CRM's Asterisk
 * PBX bridge already logs into public.contact as a phone_record row, and which the PBX records),
 * fetch that recording, transcribe it, and have the advisor draft the broker's file note in the
 * house style. When the broker opens the CRM's own Add Comment popup for that client, the popup
 * asks the sidecar for the draft and fills its textarea with it; the broker edits and saves as
 * usual. The saved comment is indistinguishable from a typed one — the sidecar never writes to
 * the CRM.
 *
 * AUDIO FORMAT CAVEAT (unverified): the real Voiteck/Asterisk portal has not been sampled. The
 * pipeline handles PCM WAV fully (split, mix, chunk) and treats anything else — WAV49/GSM 6.10,
 * A-law/mu-law WAV, mp3 — as an opaque one-shot upload capped by maxOneShotBytes / maxRecordingSeconds
 * (duration is read from the WAV header's byte rate when there is one). If production recordings
 * turn out to be a compressed WAV, long calls will be refused rather than split; a decoder would be
 * the next step. See README "Call notes".
 */
import { config } from '../config';

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}
function numEnv(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}
function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'off';
}

function pbxSourceFromEnv(): 'db' | 'env' | 'off' {
  const v = (process.env.AIADVISOR_PBX_SOURCE || (process.env.AIADVISOR_PBX_BASE_URL ? 'env' : 'off')).trim().toLowerCase();
  return v === 'db' ? 'db' : v === 'env' ? 'env' : 'off';
}

export const callNotesConfig = {
  /**
   * Master switch for the whole feature (routes 404 when off — not advertised). Default ON wherever
   * an OpenAI key exists — deliberately: that enables ONLY the dictation/upload path (the broker
   * supplies the audio). Fetching the CRM's own call recordings is a separate switch (pbxSource,
   * default off) because that contacts the PBX portal and bills STT for every logged call.
   */
  enabled: boolEnv('AIADVISOR_CALL_NOTES', true),

  /**
   * The CRM's JVM zone. public.contact.date_edited is a timestamp WITHOUT time zone written by the
   * CRM (Waterfind is Adelaide-based), so every age/window computed from it goes through
   * `date_edited AT TIME ZONE <this>` — never the sidecar host's or the PG session's zone.
   */
  crmTz: process.env.AIADVISOR_CRM_TZ || 'Australia/Adelaide',

  // ---- speech-to-text ------------------------------------------------------------------
  /** Speaker-labelling model for call audio (segments carry speaker/start/end). */
  diarizeModel: process.env.AIADVISOR_CALL_STT_MODEL || 'gpt-4o-transcribe-diarize',
  /** Plain fallback when the diarizing model fails or is unavailable: the dictation model. */
  fallbackModel: config.transcribeModel,
  /** Per-request upload cap at the provider (OpenAI: 25 MB). Chunking keeps under this. */
  maxUploadBytes: intEnv('AIADVISOR_CALL_STT_MAX_UPLOAD_BYTES', 24 * 1024 * 1024),
  /** Max seconds per transcription chunk (the diarizing model's own ceiling is ~1400 s). */
  maxChunkSeconds: intEnv('AIADVISOR_CALL_STT_MAX_CHUNK_SECONDS', 20 * 60),
  /** Whole-recording cap: anything longer is refused rather than run up a bill on a stuck line. */
  maxRecordingSeconds: intEnv('AIADVISOR_CALL_MAX_SECONDS', 3 * 60 * 60),
  /** Byte cap on a PBX download / an uploaded body (checked against Content-Length before any
   *  buffering, and the PBX stream is aborted past it). 60 MB = ~65 min of 8 kHz 16-bit stereo. */
  maxRecordingBytes: intEnv('AIADVISOR_CALL_MAX_BYTES', 60 * 1024 * 1024),
  /** A container we cannot split (non-PCM WAV, mp3, webm, ...) goes to the provider in ONE request:
   *  hard byte cap for that path (must fit maxUploadBytes anyway). */
  maxOneShotBytes: intEnv('AIADVISOR_CALL_ONESHOT_MAX_BYTES', 24 * 1024 * 1024),
  /** Process-wide audio bytes held in memory at once (uploads being buffered + jobs in flight).
   *  Beyond it a new request is refused with 429 rather than growing the heap. */
  maxBytesInFlight: intEnv('AIADVISOR_CALL_NOTE_BYTES_IN_FLIGHT', 256 * 1024 * 1024),
  /** How many chunks are in flight at the provider at once. */
  sttConcurrency: intEnv('AIADVISOR_CALL_STT_CONCURRENCY', 3),
  /** Per-request timeout for one chunk. */
  sttTimeoutMs: intEnv('AIADVISOR_CALL_STT_TIMEOUT_MS', 240_000),

  // ---- summarising ---------------------------------------------------------------------
  /** Model that drafts the note. Defaults to the advisor's own model (quality over speed). */
  noteModel: process.env.AIADVISOR_CALL_NOTE_MODEL || config.model,
  noteTimeoutMs: intEnv('AIADVISOR_CALL_NOTE_TIMEOUT_MS', 150_000),
  /** Transcript characters handed to the summariser (very long calls are head+tail trimmed). */
  noteTranscriptMaxChars: intEnv('AIADVISOR_CALL_NOTE_TRANSCRIPT_MAX_CHARS', 60_000),

  // ---- spend cap -----------------------------------------------------------------------
  /** Drafting spend (the recorded cost_usd of notes that became ready in the last 24 h) beyond
   *  which no new draft is started (the worker pauses, popups stay empty) until it rolls off.
   *  0 = no cap. ~100 calls a business day at ~$0.11 each. */
  dailyBudgetUsd: numEnv('AIADVISOR_CALL_NOTE_DAILY_BUDGET_USD', 20),

  // ---- PBX (recording source) ---------------------------------------------------------
  /**
   * Where recordings come from. `db` = the CRM's own phone_system_settings row (pbx_server_*
   * columns), exactly what ContactBo.getPhoneCall reads — PRODUCTION sets this explicitly;
   * `env` = the AIADVISOR_PBX_* values below (dev/test against the fake PBX, or a replica without
   * the settings row); `off` = no recording fetch at all (dictation/upload only).
   * Default OFF: a replica or laptop with a full DB copy and an OpenAI key must not start logging
   * into the real PBX portal (and billing STT/model calls) just because someone opened the rail.
   */
  pbxSource: pbxSourceFromEnv(),
  pbxBaseUrl: process.env.AIADVISOR_PBX_BASE_URL || '',
  pbxUser: process.env.AIADVISOR_PBX_USER || '',
  pbxPassword: process.env.AIADVISOR_PBX_PASSWORD || '',
  /**
   * Optional HTTP proxy for PBX portal requests ONLY (no other sidecar traffic). The portal may
   * IP-whitelist its callers; a host without a static IP routes these requests through one that
   * has (dev: the wf-tunnel forward http://127.0.0.1:9446 -> tinyproxy on the Hetzner box, egress
   * 5.78.145.207). Empty = direct.
   */
  pbxProxy: process.env.AIADVISOR_PBX_PROXY || '',
  pbxTimeoutMs: intEnv('AIADVISOR_PBX_TIMEOUT_MS', 60_000),
  /** A recording is fetchable this long after the call (mirrors the CRM's own 6-month link gate). */
  recordingMaxAgeDays: intEnv('AIADVISOR_CALL_RECORDING_MAX_AGE_DAYS', 180),
  /** The PBX writes the file at hangup and the portal may lag: retry a fresh call's fetch. */
  fetchRetries: intEnv('AIADVISOR_PBX_FETCH_RETRIES', 4),
  fetchRetryDelayMs: intEnv('AIADVISOR_PBX_FETCH_RETRY_MS', 15_000),
  /**
   * Which stereo channel carries the broker when the PBX records the two legs separately.
   * 'left' | 'right' | 'unknown' (labels become Speaker A/B and the summariser works out who is
   * who from content — the broker introduces themselves as Waterfind). Ignored when the two
   * channels turn out to be the same mix (dual-mono): that is mixed down and diarized instead.
   */
  stereoBrokerChannel: (process.env.AIADVISOR_PBX_STEREO_BROKER || 'unknown') as 'left' | 'right' | 'unknown',

  // ---- pre-drafting worker -------------------------------------------------------------
  /**
   * The worker (call-notes/auto.ts): when a logged call ends, draft the note in the background so
   * it is ready by the time the broker opens the CRM's Add Comment popup (which asks for it —
   * routes.ts). Nothing is written to the CRM by the sidecar. Runs only when the feature is on
   * AND pbxSource is configured (setting a PBX source is the opt-in to per-call STT billing).
   */
  autoEnabled: boolEnv('AIADVISOR_CALL_NOTES_AUTO', true),
  autoPollSeconds: intEnv('AIADVISOR_CALL_NOTES_AUTO_POLL_SECONDS', 60),
  /** Calls shorter than this are skipped (ring-outs / misdials: nothing to write up). */
  autoMinCallSeconds: intEnv('AIADVISOR_CALL_NOTES_AUTO_MIN_CALL_SECONDS', 15),
  /** Only calls that STARTED within this window are picked up — bounds the backfill after a
   *  restart (a call the worker missed is still drafted on demand when the popup asks for it). */
  autoLookbackMinutes: intEnv('AIADVISOR_CALL_NOTES_AUTO_LOOKBACK_MINUTES', 60),
  /** Auto note jobs in flight at once. */
  autoConcurrency: intEnv('AIADVISOR_CALL_NOTES_AUTO_CONCURRENCY', 2),
  /** Re-draft attempts on a transiently-failed auto note (PBX lag/outage, STT/model hiccup). */
  autoDraftMaxAttempts: intEnv('AIADVISOR_CALL_NOTES_AUTO_DRAFT_MAX_ATTEMPTS', 3),
  /** Quiet time before a failed auto note is re-drafted. */
  autoRetryBackoffMinutes: intEnv('AIADVISOR_CALL_NOTES_AUTO_RETRY_BACKOFF_MINUTES', 5),

  // ---- Add Comment prefill --------------------------------------------------------------
  /**
   * When the popup opens, the broker's most recent ended call with the client is the one the
   * note is for — provided it ended within this window and the broker has not already written it
   * up. Brokers write the note 3-15 minutes after the call; the window only has to cover a
   * broker who was pulled away first.
   */
  prefillWindowMinutes: intEnv('AIADVISOR_CALL_NOTE_PREFILL_WINDOW_MINUTES', 180),

  // ---- listing / polling --------------------------------------------------------------
  /** How far back the manual-note-exists check and candidate listing look. */
  callsDefaultHours: intEnv('AIADVISOR_CALLS_DEFAULT_HOURS', 48),
  callsMaxHours: intEnv('AIADVISOR_CALLS_MAX_HOURS', 24 * 14),
  /** A job stuck in a non-terminal state this long with no job in this process is retryable
   *  (belt-and-braces: a restart already fails every orphaned row at boot). */
  staleJobMinutes: intEnv('AIADVISOR_CALL_NOTE_STALE_MIN', 15),
  /**
   * Retention for the transcript + draft (the audit row itself stays). 0 = keep indefinitely —
   * the default (Waterfind keeps them; the recordings themselves already live on the PBX portal).
   * When > 0 a daily sweep blanks transcript/summary (and the copy "Ask advisor" pasted into a
   * chat) on rows older than this many days.
   */
  retentionDays: intEnv('AIADVISOR_CALL_NOTE_RETENTION_DAYS', 0),
};

/** Whether the feature can run at all: needs the STT key and the switch. */
export function callNotesEnabled(): boolean {
  return callNotesConfig.enabled && !!config.openaiApiKey;
}
