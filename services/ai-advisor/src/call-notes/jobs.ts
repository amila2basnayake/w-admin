/**
 * The call-note pipeline, run in-process (one Promise per note id, deduplicated): fetch the
 * recording -> transcribe -> ground -> draft -> ready. Every stage writes its status to the row
 * so the rail's poll can show "transcribing (chunk 2/5)…". Jobs live in THIS process only: at boot
 * every row still in flight is an orphan of the previous process and is failed ('restarted') so
 * the next POST re-runs it at once (see startCallNotesMaintenance).
 *
 * Status writes are SERIALISED per note (a small promise chain): the progress callbacks fire
 * from inside the fetch/STT helpers, and a fire-and-forget UPDATE racing the terminal
 * setReady/setFailed could otherwise land last and leave a finished row reading "fetching".
 */
import { fetchRecording } from './pbx';
import { transcribeCall, CallNoteError, type Transcript } from './transcript';
import { clientGrounding } from './grounding';
import { draftCallNote, type CallMeta } from './summarize';
import { callNotesConfig as C, callNotesEnabled } from './config';
import { parseWav } from './wav';
import { reserveBytes, type ByteReservation } from './budget';
import { recordSpend, priceOpenAiAudio } from '../spend';
import {
  setStage, setAudioMeta, setTranscript, setReady, setFailed, sweepRetention, failOrphanedJobs,
  type CallNoteRow, type CallNoteStatus,
} from './store';

const running = new Map<number, Promise<void>>();

export function isRunning(id: number): boolean { return running.has(id); }

interface RunInput {
  row: CallNoteRow;
  clientName: string;
  staffName: string;
  /** Provided for dictation/upload; PBX notes fetch their own. */
  audio?: { buf: Buffer; ext?: string; mime?: string } | null;
  /** The memory-budget reservation the route took for `audio`; the pipeline releases it once STT is done. */
  reservation?: ByteReservation | null;
  /** The call ended moments ago -> the PBX may still be writing the file: retry fetch. */
  fresh?: boolean;
}

/** Per-note serialised status writer. */
function stageWriter(id: number) {
  let chain: Promise<void> = Promise.resolve();
  const push = (status: CallNoteStatus, detail: string | null = null): Promise<void> => {
    chain = chain.then(() => setStage(id, status, detail)).catch((e) => console.warn(`[call-notes] stage write failed for ${id}:`, e?.message ?? e));
    return chain;
  };
  const drain = () => chain;
  return { push, drain };
}

/** Kick off (or join) the pipeline for a row. Resolves when it is ready or failed. */
export function runNote(input: RunInput): Promise<void> {
  const id = input.row.id;
  const existing = running.get(id);
  if (existing) return existing;
  const stages = stageWriter(id);
  const p = pipeline(input, stages)
    .catch(async (e: any) => {
      const msg = e instanceof CallNoteError ? e.message : (e?.message ?? String(e));
      const code = e instanceof CallNoteError ? e.code : 'internal';
      console.error(`[call-notes] note ${id} failed (${code}): ${msg}`);
      await stages.drain();
      await setFailed(id, msg, code).catch(() => undefined);
    })
    .finally(() => { running.delete(id); input.audio = null; input.reservation?.release(); input.reservation = null; });
  running.set(id, p);
  return p;
}

/** Render an instant in the CRM's zone for the summariser ("Started: 2026-08-17 10:00 ACST"). */
function crmLocal(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: C.crmTz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).formatToParts(d);
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
  } catch { return d.toISOString(); }
}

async function pipeline(input: RunInput, stages: ReturnType<typeof stageWriter>): Promise<void> {
  const { row } = input;
  const id = row.id;
  let t: Transcript;
  // A PBX job holds up to maxRecordingBytes while it fetches; hold that much of the budget until
  // the real size is known. Uploads were reserved by the route (before the body was buffered) and
  // the reservation is handed over here so it is released the moment STT no longer needs the bytes.
  let hold: ByteReservation | null = input.reservation ?? null;
  input.reservation = null;

  try {
    if (row.transcript && !input.audio) {
      // Retry after a failure downstream of STT: the paid-for transcript is reused as-is.
      t = row.transcript;
      await stages.push('drafting', 'reusing the transcript from the previous attempt');
    } else {
      // 1) audio
      let audio: Buffer, ext: string | undefined, mime: string | undefined;
      if (input.audio) {
        audio = input.audio.buf; ext = input.audio.ext; mime = input.audio.mime;
        input.audio = null;                          // the pipeline's local is now the only reference
      } else {
        if (!row.phonecall_id) throw new CallNoteError('no recording and no audio supplied', 400, 'no_audio');
        hold = reserveBytes(C.maxRecordingBytes, 'call audio');
        await stages.push('fetching');
        const r = await fetchRecording(row.phonecall_id, {
          fresh: !!input.fresh,
          onAttempt: (n, res) => { if (!res.ok) void stages.push('fetching', `attempt ${n}: ${res.message}`); },
        });
        if (!r.ok) {
          const map: Record<string, { status: number; code: string; msg: string }> = {
            not_configured: { status: 503, code: 'pbx_not_configured', msg: 'Call recordings are not connected on this server.' },
            auth: { status: 502, code: 'pbx_auth', msg: 'Could not log in to the phone system to fetch the recording.' },
            not_found: { status: 404, code: 'recording_not_found', msg: 'The phone system has no recording for this call (yet).' },
            unavailable: { status: 502, code: 'pbx_unavailable', msg: 'The phone system did not respond.' },
            too_large: { status: 413, code: 'recording_too_large', msg: 'The recording is too large to process.' },
          };
          const m = map[r.reason] ?? { status: 502, code: 'pbx_error', msg: r.message };
          throw new CallNoteError(m.msg, m.status, m.code);
        }
        audio = r.audio; ext = r.ext; mime = r.contentType;
        hold.shrinkTo(audio.length);
      }
      const info = parseWav(audio);
      await stages.drain();
      await setAudioMeta(id, { seconds: info?.seconds ?? null, bytes: audio.length, channels: info?.channels ?? null });

      // 2) transcript
      await stages.push('transcribing');
      t = await transcribeCall(audio, {
        ext, mime,
        mode: row.source === 'dictation' ? 'monologue' : 'call',
        onLayout: (_layout, detail) => { void stages.push('transcribing', detail); },
        onProgress: (done, total) => { if (total > 1) void stages.push('transcribing', `chunk ${done}/${total}`); },
      });
      // Nothing below needs the audio; drop the pipeline's reference (the route's is already gone).
      audio = Buffer.alloc(0);
      hold?.release(); hold = null;
      await stages.drain();
      await setTranscript(id, t);
      await stages.push('drafting');
    }

    // 3) grounding + draft
    const g = await clientGrounding(row.client_uid, input.clientName);
    const meta: CallMeta = {
      source: row.source,
      direction: row.direction === 'incoming' || row.direction === 'outgoing' ? row.direction : null,
      startedAt: row.call_started_at ? crmLocal(new Date(row.call_started_at)) : null,
      seconds: t.seconds ?? row.audio_seconds ?? null,
      phoneNumber: null,
      staffName: input.staffName,
    };
    const { draft, model, costUsd } = await draftCallNote(t, meta, g);
    await stages.drain();
    await setReady(id, draft, { stt: t.models, note: model }, costUsd);
    // Ledger: STT per model (list-price estimate from the billed seconds) + the drafting turn
    // (SDK-reported). Keyed by note, so a retry that reused the transcript adds nothing twice.
    for (const [m, secs] of Object.entries(t.billed ?? {})) {
      void recordSpend({ source: 'call_note_stt', vendor: 'openai', model: m, quantity: secs, unit: 'seconds', costUsd: priceOpenAiAudio(m, secs), estimated: true, ref: `call_note:${id}:stt:${m}`, userId: row.staff_user_id });
    }
    void recordSpend({ source: 'call_note_draft', vendor: 'anthropic', model, costUsd, ref: `call_note:${id}:draft`, userId: row.staff_user_id });
    console.log(`[call-notes] note ${id} ready (${row.source}${row.phonecall_id ? ' ' + row.phonecall_id : ''}, ${t.layout ?? 'n/a'}, ${t.chunks} chunk(s), ${Math.round(t.seconds ?? 0)} s)`);
  } finally {
    hold?.release();
  }
}

// ---- maintenance: boot orphan sweep + daily retention sweep ---------------------------------
let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Called once at boot. (1) Fails every row the previous process left in flight — jobs are
 * in-process, so nothing will ever finish them. (2) Starts the daily retention sweep when
 * retentionDays > 0. Skipped entirely when the feature is off: a feature-off sidecar sharing the
 * DB with a live one (dev/test) must not touch the live one's rows.
 */
export function startCallNotesMaintenance(): void {
  if (!callNotesEnabled()) return;
  failOrphanedJobs()
    .then((n) => { if (n) console.log(`[call-notes] failed ${n} orphaned job(s) from a previous process (error_code=restarted)`); })
    .catch((e) => console.warn('[call-notes] orphan sweep failed:', e?.message ?? e));
  if (sweepTimer || !(C.retentionDays > 0)) return;
  const tick = () => sweepRetention().then((n) => { if (n) console.log(`[call-notes] retention sweep blanked ${n} note(s)`); })
    .catch((e) => console.warn('[call-notes] retention sweep failed:', e?.message ?? e));
  sweepTimer = setInterval(tick, 24 * 3600_000);
  sweepTimer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}

/** Back-compat name used by server.ts boot; now also runs the orphan sweep. */
export const startRetentionSweep = startCallNotesMaintenance;
