// Text shaping for the phone: the model streams text, Retell synthesises whatever we hand it, so we
// (1) flush at sentence boundaries — TTS starts sooner and barge-in cuts cleanly between sentences,
// (2) turn chat notation into spoken forms ("$95/ML" → "95 dollars a megalitre"), and (3) strip any
// markdown that slips through (the stripper and the unit expander are shared with the web read-aloud).
import { markdownToSpeech, expandUnitsForSpeech } from '../tts';

const ABBREV = /(?:\b(?:mr|mrs|ms|dr|st|no|vs|etc|e\.g|i\.e|approx|inc|pty|ltd)\.)$/i;

/**
 * Incremental sentence chunker. Feed deltas; get back complete sentences to speak. `flush()` returns
 * whatever is left (call at end of turn).
 */
export class SentenceChunker {
  private buf = '';
  constructor(private minChars = 12) {}

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    // Scan for terminators followed by whitespace/end. Newlines are boundaries too.
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      const isTerm = ch === '.' || ch === '?' || ch === '!' || ch === '\n';
      if (!isTerm) continue;
      const next = this.buf[i + 1];
      if (ch !== '\n' && next !== undefined && !/\s/.test(next)) continue;   // "95.50", "e.g.x"
      if (next === undefined && ch !== '\n') break;                           // wait for the following char
      const candidate = this.buf.slice(start, i + 1);
      if (ch === '.' && ABBREV.test(candidate.trim())) continue;
      // Decimal like "1.5" at the very end followed by space is fine (next is space, digit before dot handled above).
      if (candidate.trim().length < this.minChars && next !== undefined) continue;
      const s = candidate.trim();
      if (s) out.push(s);
      start = i + 1;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  flush(): string | null {
    const s = this.buf.trim();
    this.buf = '';
    return s || null;
  }

  get pending(): string { return this.buf; }
}

/**
 * Chat/markdown text → something a TTS engine says well. Idempotent. The unit/abbreviation rewriting is
 * ENGLISH: for any other caller language (`lang` = the session's detected base code) only the markdown
 * strip and the internal-tag net apply — the persona has the model write figures as digits with the unit
 * in the caller's language, which the voice engine reads correctly; "dollars a megalitre" spliced into a
 * Vietnamese sentence would not be.
 */
export function toSpoken(text: string, lang = 'en'): string {
  let s = markdownToSpeech(text);
  // The web stripper points at the screen; on a phone there is none. The persona forbids tables and
  // charts on calls, so if one slips through the caller hears an honest sentence instead.
  s = s.replace(/See the (?:chart|table|code block) on screen\./g, 'I can send those figures to your broker to follow up.');
  if (lang === 'en') s = expandUnitsForSpeech(s);
  // Region ids and internal tags should never be spoken; the persona forbids them, this is the net.
  s = s.replace(/\bregion[_ ]id\s*\d+\b/gi, 'that zone');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}
