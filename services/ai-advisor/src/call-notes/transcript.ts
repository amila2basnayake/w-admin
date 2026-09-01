/**
 * Speech-to-text for whole phone calls (as opposed to transcribe.ts, which is one short dictation
 * clip). Produces a speaker-labelled, time-stamped transcript from:
 *   - a stereo PCM WAV (PBX recorded each leg on its own channel): each channel is transcribed on
 *     its own and the two are interleaved by time — the labels are then exact by construction;
 *   - a mono PCM WAV: the diarizing model labels speakers (A/B); across chunks of a long call the
 *     first chunk's voices are handed to later chunks as known-speaker references so "A" stays "A";
 *   - any other container (mp3/webm/…, e.g. a dictated debrief or an uploaded file): one request.
 * Long recordings are chunked under the provider's per-upload limits (bytes AND seconds), and every
 * chunk that the diarizing model rejects falls back to the plain dictation model, so a note is
 * still produced (unlabelled) rather than nothing.
 */
import { config } from '../config';
import { callNotesConfig as C } from './config';
import { parseWav, splitChannels, splitWav, buildWav, sniffAudio, mixToMono, channelSimilarity, type WavInfo, type WavChunk } from './wav';

export class CallNoteError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'bad_request') {
    super(message);
    this.name = 'CallNoteError';
    this.status = status;
    this.code = code;
  }
}

export interface Segment { speaker: string | null; start: number; end: number; text: string; }
export interface Transcript {
  segments: Segment[];
  /** Plain rendering: one line per segment, "A: …" when labelled. */
  text: string;
  diarized: boolean;
  /** Which model(s) produced it. */
  models: string[];
  /** Audio seconds actually sent to the provider, per model (stereo legs bill each channel; silent chunks are skipped). */
  billed?: Record<string, number>;
  seconds: number | null;
  channels: number | null;
  chunks: number;
  warnings: string[];
  /** Which path produced it (see decideLayout). */
  layout?: AudioLayout;
}

export type SttMode = 'call' | 'monologue';

/**
 * How the audio was treated:
 *  - 'stereo-legs': one party per channel -> each channel transcribed alone, labels exact;
 *  - 'dual-mono':   2+ channels carrying the same mix -> mixed down, diarized (else every line
 *                   would come out twice as A/B);
 *  - 'mono':        single channel (or a monologue) -> diarized;
 *  - 'one-shot':    a container we cannot split -> one provider request.
 */
export type AudioLayout = 'stereo-legs' | 'dual-mono' | 'mono' | 'one-shot';

/**
 * Decide the stereo treatment from the PCM itself. Exported for tests (no provider call).
 * `detail` is the human-readable reason written to the note's stage_detail.
 */
export function decideLayout(audio: Buffer, info: WavInfo, mode: SttMode): { layout: AudioLayout; detail: string } {
  if (!info.pcm) return { layout: 'one-shot', detail: `WAV format ${info.format} sent whole (not PCM)` };
  if (info.channels < 2) return { layout: 'mono', detail: 'mono' };
  if (mode !== 'call') return { layout: 'mono', detail: `${info.channels}-channel monologue${info.bitsPerSample === 16 ? ' mixed to mono' : ''}` };
  if (info.bitsPerSample !== 16) return { layout: 'stereo-legs', detail: `${info.bitsPerSample}-bit stereo (no similarity check) -> per-channel` };
  const sim = channelSimilarity(audio, info);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (sim.dualMono) return { layout: 'dual-mono', detail: `stereo channels identical (corr ${pct(sim.correlation)}) -> mixed to mono, diarized` };
  if (!sim.measurable) return { layout: 'stereo-legs', detail: 'stereo, a channel is silent -> per-channel' };
  return { layout: 'stereo-legs', detail: `stereo legs (corr ${pct(sim.correlation)}, residual ${pct(sim.residualRatio)}) -> per-channel` };
}

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const SILENCE_RMS = 40;               // of 32767 -> about -58 dBFS: nothing there, do not bill it
const REF_CLIP_SECONDS = 8;           // known-speaker reference length handed to later chunks

// ---- provider calls --------------------------------------------------------------------

async function sttPost(form: FormData, signal?: AbortSignal): Promise<any> {
  if (!config.openaiApiKey) throw new CallNoteError('transcription not configured', 503, 'not_configured');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), C.sttTimeoutMs);
  const onOuter = () => ac.abort();
  signal?.addEventListener('abort', onOuter, { once: true });
  let res: Response;
  try {
    res = await fetch(OPENAI_URL, { method: 'POST', headers: { Authorization: `Bearer ${config.openaiApiKey}` }, body: form, signal: ac.signal });
  } catch (e: any) {
    if (signal?.aborted) throw new CallNoteError('cancelled', 499, 'cancelled');
    throw new CallNoteError(e?.name === 'AbortError' ? 'transcription timed out' : 'transcription upstream unreachable', 502, 'upstream');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[call-notes] STT ${res.status}: ${detail.slice(0, 400)}`);
    const err = new CallNoteError(`transcription failed (${res.status})`, 502, 'upstream');
    (err as any).providerStatus = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

/** Diarizing request -> segments (speaker/start/end/text). */
async function sttDiarize(
  audio: Buffer, ext: string, mime: string,
  refs: { names: string[]; dataUris: string[] } | null,
  signal?: AbortSignal,
): Promise<Segment[]> {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`);
  form.append('model', C.diarizeModel);
  form.append('response_format', 'diarized_json');
  form.append('chunking_strategy', 'auto');
  if (refs) {
    for (let i = 0; i < refs.names.length; i++) {
      form.append('known_speaker_names[]', refs.names[i]);
      form.append('known_speaker_references[]', refs.dataUris[i]);
    }
  }
  const json = await sttPost(form, signal);
  const raw: any[] = Array.isArray(json?.segments) ? json.segments : [];
  const segs: Segment[] = raw
    .map((s) => ({
      speaker: s?.speaker != null ? String(s.speaker) : null,
      start: Number(s?.start ?? 0) || 0,
      end: Number(s?.end ?? s?.start ?? 0) || 0,
      text: String(s?.text ?? '').trim(),
    }))
    .filter((s) => s.text);
  if (!segs.length && typeof json?.text === 'string' && json.text.trim()) {
    return [{ speaker: null, start: 0, end: 0, text: json.text.trim() }];
  }
  return segs;
}

/** Plain request (dictation model, vocabulary prompt) -> one unlabelled segment. */
async function sttPlain(audio: Buffer, ext: string, mime: string, signal?: AbortSignal): Promise<Segment[]> {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`);
  form.append('model', C.fallbackModel);
  form.append('response_format', 'json');
  if (config.transcribeVocabulary) form.append('prompt', config.transcribeVocabulary);
  const json = await sttPost(form, signal);
  const text = String(json?.text ?? '').trim();
  return text ? [{ speaker: null, start: 0, end: 0, text }] : [];
}

// ---- helpers ---------------------------------------------------------------------------

function rms16(wav: Buffer): number {
  const info = parseWav(wav);
  if (!info || !info.pcm || info.bitsPerSample !== 16) return Infinity;   // unknown -> not silent
  const pcm = wav.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  // Sample every 4th frame for speed; RMS on a call is a coarse gate, not a measurement.
  let acc = 0, cnt = 0;
  for (let i = 0; i < n; i += 4) { const v = pcm.readInt16LE(i * 2); acc += v * v; cnt++; }
  return Math.sqrt(acc / Math.max(1, cnt));
}

/** Cut a reference clip (<= REF_CLIP_SECONDS) for each speaker out of a mono 16-bit chunk. */
function speakerReferences(chunkWav: Buffer, segs: Segment[]): { names: string[]; dataUris: string[] } | null {
  const info = parseWav(chunkWav);
  if (!info || !info.pcm || info.channels !== 1 || info.bitsPerSample !== 16) return null;
  const pcm = chunkWav.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  const bySpeaker = new Map<string, Segment[]>();
  for (const s of segs) if (s.speaker) (bySpeaker.get(s.speaker) ?? bySpeaker.set(s.speaker, []).get(s.speaker)!).push(s);
  const names: string[] = [], dataUris: string[] = [];
  for (const [name, list] of bySpeaker) {
    if (names.length >= 4) break;
    const sorted = [...list].sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const parts: Buffer[] = [];
    let got = 0;
    for (const s of sorted) {
      const dur = Math.min(s.end - s.start, REF_CLIP_SECONDS - got);
      if (dur <= 0.5) continue;
      const a = Math.floor(s.start * info.sampleRate) * 2, b = Math.floor((s.start + dur) * info.sampleRate) * 2;
      if (b <= a || b > pcm.length) continue;
      parts.push(pcm.subarray(a, b));
      got += dur;
      if (got >= REF_CLIP_SECONDS) break;
    }
    if (got < 2) continue;                       // too little voice to be a useful reference
    const wav = buildWav(Buffer.concat(parts), { channels: 1, sampleRate: info.sampleRate, bitsPerSample: 16 });
    names.push(name);
    dataUris.push('data:audio/wav;base64,' + wav.toString('base64'));
  }
  return names.length ? { names, dataUris } : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

/** Consecutive segments by the same speaker collapse into one turn — the provider emits a segment per phrase. */
export function mergeTurns(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 3) {
      last.text = `${last.text} ${s.text}`.replace(/\s+/g, ' ').trim();
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export function renderTranscript(segs: Segment[]): string {
  return mergeTurns(segs).map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n');
}

/**
 * Speaker labels within one chunk are relabelled to whatever the provider used, in first-appearance
 * order, mapped onto A, B, C…: keeps them short and stable-looking in the note UI.
 */
function normaliseLabels(segs: Segment[], fixed?: string): Segment[] {
  if (fixed) return segs.map((s) => ({ ...s, speaker: fixed }));
  const map = new Map<string, string>();
  const letters = 'ABCDEFGH';
  return segs.map((s) => {
    if (!s.speaker) return s;
    if (!map.has(s.speaker)) map.set(s.speaker, letters[map.size] ?? s.speaker);
    return { ...s, speaker: map.get(s.speaker)! };
  });
}

// ---- main entry ------------------------------------------------------------------------

export interface TranscribeCallOpts {
  /** Container extension hint from the caller (Content-Type / PBX sniff). */
  ext?: string;
  mime?: string;
  mode?: SttMode;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Fired once the treatment is decided (before any provider call) — the job writes it to stage_detail. */
  onLayout?: (layout: AudioLayout, detail: string) => void;
}

/**
 * Transcribe a whole recording. Throws CallNoteError for input problems (too long, too large,
 * unsupported); provider trouble on a chunk degrades to the plain model rather than failing.
 */
export async function transcribeCall(audio: Buffer, opts: TranscribeCallOpts = {}): Promise<Transcript> {
  if (!audio || !audio.length) throw new CallNoteError('empty audio', 400, 'empty');
  const sniff = sniffAudio(audio);
  const ext = sniff?.ext ?? opts.ext ?? 'wav';
  const mime = sniff?.mime ?? opts.mime ?? 'audio/wav';
  const mode: SttMode = opts.mode ?? 'call';
  const warnings: string[] = [];
  const models = new Set<string>();
  const billed: Record<string, number> = {};
  let diarized = true;

  let info: WavInfo | null = ext === 'wav' ? parseWav(audio) : null;

  // Seconds a provider request will be billed for: the unit's own WAV header, else the whole
  // recording's (one-shot), else unknown.
  const secondsOf = (buf: Buffer, uExt: string): number | null => {
    const i = uExt === 'wav' ? parseWav(buf) : null;
    const s = i?.seconds ?? info?.seconds ?? null;
    return typeof s === 'number' && s > 0 ? s : null;
  };
  const bill = (model: string, secs: number | null) => { models.add(model); if (secs != null) billed[model] = (billed[model] ?? 0) + secs; };

  // One provider request for a unit of audio, with the plain-model fallback.
  async function unit(buf: Buffer, uExt: string, uMime: string, refs: { names: string[]; dataUris: string[] } | null, allowDiarize: boolean): Promise<Segment[]> {
    const secs = secondsOf(buf, uExt);
    if (allowDiarize) {
      try {
        const segs = await sttDiarize(buf, uExt, uMime, refs, opts.signal);
        bill(C.diarizeModel, secs);
        return segs;
      } catch (e: any) {
        if (e?.code === 'cancelled') throw e;
        if (refs) {
          // References are best-effort — a rejected reference must not cost the chunk.
          try { const segs = await sttDiarize(buf, uExt, uMime, null, opts.signal); bill(C.diarizeModel, secs); warnings.push('speaker references rejected; labels may not carry across chunks'); return segs; }
          catch (e2: any) { if (e2?.code === 'cancelled') throw e2; }
        }
        warnings.push(`diarizing model failed (${e?.message ?? e}); used ${C.fallbackModel}`);
      }
    }
    diarized = false;
    const segs = await sttPlain(buf, uExt, uMime, opts.signal);
    bill(C.fallbackModel, secs);
    return segs;
  }

  // ---- non-PCM: one shot -------------------------------------------------------------
  // A container we cannot split (mp3/webm/ogg, or a compressed WAV such as GSM/WAV49, A-law,
  // mu-law — the real PBX format is UNVERIFIED, see config.ts) goes to the provider whole, so it
  // is capped by bytes (maxOneShotBytes, itself within the provider's upload limit) and, when the
  // WAV header carries a byte rate, by duration too.
  if (!info || !info.pcm) {
    const cap = Math.min(C.maxOneShotBytes, C.maxUploadBytes);
    if (audio.length > cap) {
      throw new CallNoteError(`recording is ${Math.round(audio.length / 1048576)} MB in a format that cannot be split; the limit is ${Math.round(cap / 1048576)} MB`, 413, 'too_large');
    }
    if (info && info.seconds > C.maxRecordingSeconds) {
      throw new CallNoteError(`recording is ${Math.round(info.seconds / 60)} min; the limit is ${Math.round(C.maxRecordingSeconds / 60)} min`, 413, 'too_long');
    }
    const detail = info ? `WAV format ${info.format} sent whole (not PCM)` : `${ext} sent whole`;
    if (info && !info.pcm) warnings.push(detail);
    opts.onLayout?.('one-shot', detail);
    const segs = normaliseLabels(await unit(audio, ext, mime, null, mode === 'call'));
    opts.onProgress?.(1, 1);
    return {
      segments: segs, text: renderTranscript(segs), diarized: mode === 'call' && diarized, models: [...models], billed,
      seconds: info && info.seconds > 0 ? info.seconds : null, channels: info?.channels ?? null, chunks: 1, warnings, layout: 'one-shot',
    };
  }

  // ---- PCM WAV ------------------------------------------------------------------------
  if (info.seconds > C.maxRecordingSeconds) {
    throw new CallNoteError(`recording is ${Math.round(info.seconds / 60)} min; the limit is ${Math.round(C.maxRecordingSeconds / 60)} min`, 413, 'too_long');
  }
  const limits = { maxSeconds: C.maxChunkSeconds, maxBytes: C.maxUploadBytes };

  // Multi-channel: are the channels two legs (transcribe each alone, labels exact) or the same
  // mix twice (dual-mono: mix down and diarize, or every line comes out twice as A and B)?
  const decided = decideLayout(audio, info, mode);
  opts.onLayout?.(decided.layout, decided.detail);
  const sourceChannels = info.channels;
  if (info.channels >= 2 && decided.layout !== 'stereo-legs' && info.bitsPerSample === 16) {
    audio = mixToMono(audio, info);
    info = parseWav(audio)!;
    if (decided.layout === 'dual-mono') warnings.push('stereo channels carried the same mix; mixed to mono and speaker-labelled by the model');
  }

  // Stereo legs: a party per channel -> transcribe each channel alone, label by channel.
  if (decided.layout === 'stereo-legs') {
    const chans = splitChannels(audio, info);
    const labelFor = (ci: number): string => {
      if (info.channels === 2 && C.stereoBrokerChannel !== 'unknown') {
        const brokerIdx = C.stereoBrokerChannel === 'left' ? 0 : 1;
        return ci === brokerIdx ? 'Broker' : 'Client';
      }
      return 'ABCDEFGH'[ci] ?? `Ch${ci + 1}`;
    };
    const jobs: Array<{ ci: number; chunk: WavChunk }> = [];
    chans.forEach((wav, ci) => {
      const ci2 = parseWav(wav)!;
      for (const chunk of splitWav(wav, ci2, limits)) jobs.push({ ci, chunk });
    });
    let done = 0;
    const results = await mapLimit(jobs, C.sttConcurrency, async ({ ci, chunk }) => {
      let segs: Segment[] = [];
      if (rms16(chunk.wav) >= SILENCE_RMS) {
        segs = await unit(chunk.wav, 'wav', 'audio/wav', null, true);
      }
      done++; opts.onProgress?.(done, jobs.length);
      return normaliseLabels(segs, labelFor(ci)).map((s) => ({ ...s, start: s.start + chunk.startSec, end: s.end + chunk.startSec }));
    });
    const segs = results.flat().sort((a, b) => a.start - b.start || a.end - b.end);
    if (!segs.length) warnings.push('no speech detected');
    return {
      segments: segs, text: renderTranscript(segs), diarized: true, models: [...models], billed,
      seconds: info.seconds, channels: info.channels, chunks: jobs.length, warnings, layout: 'stereo-legs',
    };
  }

  // Mono (or a monologue): chunk sequentially so chunk 1's voices can seed the later chunks.
  const chunks = splitWav(audio, info, limits);
  const all: Segment[] = [];
  let refs: { names: string[]; dataUris: string[] } | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let segs: Segment[] = [];
    if (rms16(chunk.wav) >= SILENCE_RMS) {
      segs = await unit(chunk.wav, 'wav', 'audio/wav', refs, mode === 'call');
      if (mode === 'call' && chunks.length > 1 && !refs && segs.some((s) => s.speaker)) {
        refs = speakerReferences(chunk.wav, normaliseLabels(segs));
      }
    }
    // Labels: with references the provider echoes our names (A/B); without, normalise per chunk.
    segs = refs && i > 0 ? segs : normaliseLabels(segs);
    all.push(...segs.map((s) => ({ ...s, start: s.start + chunk.startSec, end: s.end + chunk.startSec })));
    opts.onProgress?.(i + 1, chunks.length);
  }
  if (chunks.length > 1 && !refs && mode === 'call') warnings.push('speaker labels may not carry across chunks');
  if (!all.length) warnings.push('no speech detected');
  return {
    segments: all, text: renderTranscript(all), diarized: mode === 'call' && diarized, models: [...models], billed,
    seconds: info.seconds, channels: sourceChannels, chunks: chunks.length, warnings, layout: decided.layout,
  };
}
