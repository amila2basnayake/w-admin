/**
 * Text-to-speech for the advisor's spoken replies — the per-message "Listen" button, the
 * spoken-in/spoken-out reply to a dictated message, and hands-free voice mode — on every chat
 * surface (client AI Advisor tab, the broker Client Rail, the AI Trainer).
 *
 * The browser POSTs an assistant message's markdown to a /tts route; this module strips the
 * markdown to speech-friendly plain text, expands trading notation to words ("$95/ML" -> "95
 * dollars a megalitre"), chunks anything long, and forwards each chunk to OpenAI's text-to-speech
 * endpoint (gpt-4o-mini-tts by default), returning one concatenated MP3. The OpenAI key never
 * leaves the sidecar — same server-side-secret posture as transcribe.ts, and it reuses the very
 * same key so a single OpenAI credential turns both dictation and playback on.
 *
 * Charts and tables are never read cell-by-cell: they collapse to "see the chart/table on screen"
 * so the audio stays conversational while the visual detail lives in the chat.
 */
import { config } from './config';
import { recordSpend, priceOpenAiTts } from './spend';

/** Thrown for a client-visible synthesis failure; `status` maps straight to the HTTP code. */
export class TtsError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TtsError';
    this.status = status;
  }
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

const OPENAI_URL = 'https://api.openai.com/v1/audio/speech';
const TTS_MODEL = process.env.AIADVISOR_TTS_MODEL || 'gpt-4o-mini-tts';
// The reader should sound like the phone channel's (Retell's Noah: Australian, male, middle-aged),
// not a neutral American voice: "ash" is the model's deeper male voice, and gpt-4o-mini-tts
// honours a free-text style instruction, so the accent is asked for explicitly.
const TTS_VOICE = process.env.AIADVISOR_TTS_VOICE || 'ash';
const TTS_INSTRUCTIONS = process.env.AIADVISOR_TTS_INSTRUCTIONS
  ?? 'Speak in a natural, understated Australian English accent — a middle-aged Australian water broker '
   + 'talking to a client: calm, clear, professional, a measured pace, plain-spoken delivery. '
   + 'Do not read out symbols or punctuation.';
// mp3 is universally playable in an <audio> element and concatenates cleanly for chunked replies.
const TTS_FORMAT = 'mp3';
// Per-request cap: OpenAI's speech endpoint accepts up to 4096 chars; stay well under so a chunk
// always fits and long replies split on sentence boundaries.
const TTS_CHUNK_CHARS = intEnv('AIADVISOR_TTS_CHUNK_CHARS', 1800);
// Total cap: bound cost/latency on a very long answer — beyond this we synthesise a sentence-aligned
// prefix and tell the listener the remainder is on screen.
const TTS_MAX_INPUT_CHARS = intEnv('AIADVISOR_TTS_MAX_INPUT_CHARS', 8000);

/** Whether playback is usable — drives the /me capability flags so the UIs can hide the voice surfaces. */
export function ttsEnabled(): boolean {
  return !!config.openaiApiKey;
}

/** What is in effect, for /health and the boot log. */
export function ttsInfo(): { enabled: boolean; provider: 'openai'; model: string; voice: string } {
  return { enabled: ttsEnabled(), provider: 'openai', model: TTS_MODEL, voice: TTS_VOICE };
}

// ---- markdown -> speech ----------------------------------------------------
// Mirror the chat renderer's block grammar (fenced code, ```chart, pipe tables, headings, lists,
// blockquotes, rules) but flatten to what a voice should actually say. Charts/tables are pointed
// at the screen, not dictated; emphasis/link/code syntax is dropped, keeping the words.

function isSepLine(s: string): boolean {
  return s.indexOf('|') >= 0 && /-{3,}/.test(s) && /^\s*\|?[\s:|-]+\|?\s*$/.test(s);
}

/** End a fragment as a spoken sentence so the model pauses between headings/list items. */
function ensureSentence(s: string): string {
  const t = s.trim();
  if (!t) return '';
  return /[.!?:;]$/.test(t) ? t : t + '.';
}

/** Flatten inline markdown (links, emphasis, code, bare URLs) to spoken words. */
function inlineToSpeech(s: string): string {
  let t = String(s);
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');              // images -> alt text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');               // [text](url) -> text
  t = t.replace(/\bhttps?:\/\/[^\s)]+/gi, '');                 // bare URLs -> drop (never read aloud)
  t = t.replace(/`([^`]+)`/g, '$1');                           // `code` -> code
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1'); // bold
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');             // *italic*
  t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1$2');             // _italic_
  t = t.replace(/~~([^~]+)~~/g, '$1');                         // ~~strike~~
  t = t.replace(/[`*_]{1,3}/g, '');                            // stray emphasis artifacts
  return t.trim();
}

/**
 * Convert an assistant message's markdown into a plain, speech-friendly string. Pure and offline —
 * the whole transformation is unit-tested without a key or a network call.
 */
export function markdownToSpeech(src: string): string {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code / ```chart blocks -> a screen pointer, never the raw contents
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim().toLowerCase();
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
      if (i < lines.length) i++; // consume the closing fence
      out.push(lang === 'chart' ? 'See the chart on screen.' : 'See the code block on screen.');
      continue;
    }

    // pipe table (header row + separator) -> a screen pointer, never cell-by-cell
    if (line.indexOf('|') >= 0 && !isSepLine(line) && i + 1 < lines.length && isSepLine(lines[i + 1])) {
      i += 2;
      while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim() !== '' && !isSepLine(lines[i])) i++;
      out.push('See the table on screen.');
      continue;
    }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { i++; continue; }   // horizontal rule -> drop

    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);                  // heading -> a sentence
    if (h) { out.push(ensureSentence(inlineToSpeech(h[1]))); i++; continue; }

    if (/^\s*>\s?/.test(line)) { out.push(inlineToSpeech(line.replace(/^\s*>\s?/, ''))); i++; continue; } // quote

    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);      // list item -> sentence, marker gone
    if (li) { out.push(ensureSentence(inlineToSpeech(li[1]))); i++; continue; }

    if (/^\s*$/.test(line)) { out.push(''); i++; continue; }    // blank -> paragraph break

    out.push(inlineToSpeech(line)); i++;
  }

  let joined = out.join('\n');
  joined = joined.replace(/[ \t]+/g, ' ');
  joined = joined.replace(/\n{2,}/g, '\n').replace(/\n/g, ' '); // paragraphs -> single spaces
  joined = joined.replace(/\s{2,}/g, ' ').trim();
  return joined;
}

// ---- trading notation -> words ---------------------------------------------
// Shared with the phone channel (voice/speech.ts): a TTS engine reads "$95/ML" as "dollar
// ninety-five slash M L"; a broker says "95 dollars a megalitre".

const UNIT_WORDS: Array<[RegExp, string]> = [
  [/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:\/|per)\s*ML\b/gi, '$1 dollars a megalitre'],
  [/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:\/|per)\s*GL\b/gi, '$1 dollars a gigalitre'],
  [/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(m|million)\b/gi, '$1 million dollars'],
  [/\$\s?(\d[\d,]*(?:\.\d+)?)\s*k\b/gi, '$1 thousand dollars'],
  [/\$\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars'],
  [/(\d[\d,]*(?:\.\d+)?)\s*ML\b/g, '$1 megalitres'],
  [/(\d[\d,]*(?:\.\d+)?)\s*GL\b/g, '$1 gigalitres'],
  [/\bML\b/g, 'megalitres'],
  [/\bGL\b/g, 'gigalitres'],
  [/(\d)\s*%/g, '$1 percent'],
  [/\bIVT\b/g, 'inter-valley transfer'],
  [/\bHS\b/g, 'high security'],
  [/\bGS\b/g, 'general security'],
  [/\bT&Cs?\b/g, 'terms and conditions'],
  [/\bp\.a\.\b/gi, 'per year'],
  [/\bMDBA\b/g, 'the Basin Authority'],
];

/** "$95/ML", "200 ML", "5%", "IVT" -> the words a broker would say. Idempotent. */
export function expandUnitsForSpeech(text: string): string {
  let s = String(text || '');
  for (const [re, rep] of UNIT_WORDS) s = s.replace(re, rep);
  return s.replace(/\b1 (megalitre|gigalitre|dollar)s\b/g, '1 $1');   // "1 megalitres" -> "1 megalitre"
}

/** Best split index at or before `limit`, cutting AFTER sentence punctuation, else whitespace. */
function boundaryBefore(s: string, limit: number): number {
  const enders = ['. ', '? ', '! ', '.\n', '?\n', '!\n', '\n'];
  let best = -1;
  for (const e of enders) {
    const idx = s.lastIndexOf(e, limit - 1);
    if (idx >= 0) best = Math.max(best, idx + e.length);
  }
  if (best > 0) return best;
  const sp = s.lastIndexOf(' ', limit - 1);
  if (sp > 0) return sp + 1;
  return limit;
}

/** Split speech text into <= maxChars chunks, preferring sentence then word boundaries. */
export function chunkForSpeech(text: string, maxChars: number = TTS_CHUNK_CHARS): string[] {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxChars) {
    const cut = boundaryBefore(rest, maxChars);
    const head = rest.slice(0, cut).trim();
    if (head) chunks.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ---- synthesis -------------------------------------------------------------

/** Test seam: the fetch used for the provider call (the suite swaps in a fake and inspects the request). */
let doFetch: typeof fetch = (input, init) => fetch(input, init);
export function _setFetch(fn: typeof fetch | null): void { doFetch = fn ?? ((input, init) => fetch(input, init)); }

/** The OpenAI request for one chunk. Pure, so the suite can assert on the wire shape. */
export function buildRequest(input: string): { url: string; init: RequestInit } {
  return {
    url: OPENAI_URL,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input,
        response_format: TTS_FORMAT,
        ...(TTS_INSTRUCTIONS ? { instructions: TTS_INSTRUCTIONS } : {}),
      }),
    },
  };
}

async function ttsRequest(input: string, signal?: AbortSignal): Promise<Buffer> {
  const { url, init } = buildRequest(input);
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    console.error('[tts] network error:', e?.message ?? e);
    throw new TtsError('text-to-speech upstream unreachable', 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Log the provider's reason for us; never surface provider internals to the browser.
    console.error(`[tts] OpenAI ${res.status}: ${detail.slice(0, 500)}`);
    throw new TtsError('text-to-speech failed', 502);
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Synthesise spoken audio for an assistant message. Markdown-stripping and the empty-text check run
 * before the key check and any network call, so they are exercisable without a live key.
 */
export async function synthesizeSpeech(
  rawText: string,
  opts: { signal?: AbortSignal; userId?: number | null } = {},
): Promise<{ audio: Buffer; contentType: string; chars: number }> {
  const speech = expandUnitsForSpeech(markdownToSpeech(rawText));
  if (!speech) throw new TtsError('nothing to speak', 400);

  let capped = speech;
  if (capped.length > TTS_MAX_INPUT_CHARS) {
    const cut = boundaryBefore(capped, TTS_MAX_INPUT_CHARS);
    capped = capped.slice(0, cut).trim() + ' The rest of this response is on screen.';
  }

  if (!config.openaiApiKey) throw new TtsError('text-to-speech not configured', 503);

  const parts: Buffer[] = [];
  let chars = 0;
  try {
    for (const chunk of chunkForSpeech(capped, TTS_CHUNK_CHARS)) {
      parts.push(await ttsRequest(chunk, opts.signal));
      chars += chunk.length;
    }
  } finally {
    // Every chunk the provider accepted is billed, whether or not the reply finished.
    if (chars) void recordSpend({ source: 'tts', vendor: 'openai', model: TTS_MODEL, quantity: chars, unit: 'chars', costUsd: priceOpenAiTts(TTS_MODEL, chars), estimated: true, userId: opts.userId ?? null });
  }
  return { audio: Buffer.concat(parts), contentType: 'audio/mpeg', chars };
}
