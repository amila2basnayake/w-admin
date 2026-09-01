/**
 * Speech-to-text for a finished audio clip (POST /transcribe).
 *
 * The caller POSTs raw audio bytes (a recording, an upload); this module forwards them to OpenAI's
 * audio-transcriptions endpoint (gpt-4o-mini-transcribe by default) and returns the plain
 * transcript. Used by call-notes dictation/upload. The composer's mic button no longer goes through
 * here — it streams live over /transcribe/stream (transcribe-stream.ts) so words appear while the
 * user is still talking; both share this module's key, model and vocabulary config. The OpenAI key
 * never leaves the sidecar — same server-side-secret posture as the Anthropic and brokerage paths.
 */
import { config } from './config';

/** Thrown for a client-visible transcription failure; `status` maps straight to the HTTP code. */
export class TranscribeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TranscribeError';
    this.status = status;
  }
}

/** Whether dictation is usable — drives the /me capability flag so the UI can hide the button. */
export function transcribeEnabled(): boolean {
  return !!config.openaiApiKey;
}

// MediaRecorder emits a handful of container types depending on the browser (webm/opus on
// Chromium, mp4 on Safari, ogg on Firefox). OpenAI infers the format from the upload filename's
// extension, so map the incoming Content-Type to an extension it accepts.
const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/oga': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mp3',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};

/** Extension OpenAI accepts for a given Content-Type, or null if we don't support it. */
export function extForMime(contentType: string): string | null {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[mime] ?? null;
}

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Transcribe one audio clip. Input validation (empty / too-large / unsupported format) runs
 * before the key check and the network call, so it is exercisable without a live key.
 */
export async function transcribeAudio(
  audio: Buffer,
  contentType: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  if (!audio || !audio.length) throw new TranscribeError('empty audio', 400);
  if (audio.length > config.transcribeMaxBytes) throw new TranscribeError('audio too large', 413);
  const ext = extForMime(contentType);
  if (!ext) throw new TranscribeError('unsupported audio format', 415);
  if (!config.openaiApiKey) throw new TranscribeError('transcription not configured', 503);

  const form = new FormData();
  // Node 18+ global FormData/Blob. The filename extension is what tells OpenAI the container.
  form.append('file', new Blob([audio], { type: contentType.split(';')[0] }), `audio.${ext}`);
  form.append('model', config.transcribeModel);
  form.append('response_format', 'json');
  if (config.transcribeVocabulary) form.append('prompt', config.transcribeVocabulary);

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
      body: form,
      signal: opts.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    console.error('[transcribe] network error:', e?.message ?? e);
    throw new TranscribeError('transcription upstream unreachable', 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Log the provider's reason for us; never surface provider internals to the browser.
    console.error(`[transcribe] OpenAI ${res.status}: ${detail.slice(0, 500)}`);
    throw new TranscribeError('transcription failed', 502);
  }

  const json = (await res.json().catch(() => ({}))) as { text?: string };
  return (json.text ?? '').trim();
}
