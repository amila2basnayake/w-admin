import { resolve } from 'node:path';
import { config } from './config';
import {
  loadDocs, validateDoc, KNOWLEDGE_DIR, type CorpusSpec, type KnowledgeDoc,
} from './knowledge-tools';

/**
 * Staff notes — short pieces of guidance Waterfind staff write directly for the advisor.
 *
 * A note is agnostic about its shape. It can be a correction ("the 4% trade-out cap no longer
 * exists; it was VIC-only and ended 1 Jul 2014"), a rule ("for NSW balances point people to iWAS"),
 * a house position, a reminder about a seasonal announcement. Two delivery modes:
 *
 *   pin       injected into the advisor's system prompt on every turn — for things the advisor gets
 *             wrong or omits WITHOUT being asked. Costs tokens on every conversation.
 *   retrieve  surfaced by search_knowledge when the topic comes up — the default.
 *
 * Notes are the most privileged text in the product authored by non-engineers, so the block is
 * rendered from a FIXED template with every field sanitised (tag-like sequences stripped, markdown
 * structure flattened, whitespace collapsed, length capped): a note can say anything, but it cannot
 * break out of its bullet or open a new section of the prompt. config.notesEnabled drops the whole
 * block — the kill switch for a bad note that is already live.
 *
 * Notes are FILES, read through the same mtime-cached loader as the corpus: serve the last good
 * copy, never throw on the advisor's hot path.
 */

export const NOTES_ROOT = resolve(KNOWLEDGE_DIR, 'notes');

export const NOTES_SPEC: CorpusSpec = {
  root: NOTES_ROOT,
  label: 'notes',
  collection: 'library',
  required: ['id', 'title', 'as_at'],
  minBody: 1,
};

export const NOTE_TEXT_MAX = 700;

export type NoteMode = 'pin' | 'retrieve';

export interface Note {
  id: string;
  title: string;
  mode: NoteMode;
  scope: string;            // jurisdiction or topic label, free text (sanitised)
  triggers: string[];       // phrases that surface this in retrieval
  text: string;             // the note itself, one paragraph, sanitised
  sourceUrls: string[];
  asAt: string;
  /** YYYY-MM-DD after which the auto-refresh re-verifies the note; 'never' = never goes stale; '' = unset (as_at + TTL applies). */
  bestBy: string;
  path: string;
}

/**
 * Reduce staff text to plain single-paragraph prose. Tags are stripped before markers so `<h1># x>`
 * cannot leave a stray marker behind; ALL whitespace (including newlines) collapses to one space.
 */
export function sanitiseField(raw: string): string {
  return String(raw ?? '')
    .replace(/<[^>]*>/g, ' ')             // tag-like sequences: <user_preferences>, <system>, <admin>
    .replace(/[`*_~]/g, '')               // markdown emphasis + code fences
    .replace(/^\s*\d+[.)]\s+/gm, ' ')     // ordered-list markers ("1. ") — but not a leading number like "4% cap"
    .replace(/^[\s>#\-+*]+/gm, ' ')       // leading headers, quotes, list markers
    .replace(/\s+/g, ' ')                 // collapse whitespace
    .trim();
}

/** Problems that make a note unservable. Empty means fine. */
export function validateNote(n: Partial<Note>): string[] {
  const problems: string[] = [];
  const text = sanitiseField(n.text ?? '');
  if (!text) problems.push('the note text is empty');
  if (text.length > NOTE_TEXT_MAX) {
    problems.push(`the note is ${text.length} characters after flattening; the limit is ${NOTE_TEXT_MAX} — keep it to a short paragraph`);
  }
  if (!sanitiseField(n.title ?? '')) problems.push('title is missing');
  for (const u of n.sourceUrls ?? []) {
    if (!/^https?:\/\/\S+$/.test(u)) problems.push(`source URL is not a plain http(s) URL: ${u}`);
  }
  if (n.mode && n.mode !== 'pin' && n.mode !== 'retrieve') problems.push('mode must be pin or retrieve');
  if (n.bestBy && n.bestBy !== 'never' && !/^\d{4}-\d{2}-\d{2}$/.test(n.bestBy)) {
    problems.push(`best_by "${n.bestBy}" is not YYYY-MM-DD or "never"`);
  }
  return problems;
}

/** A best_by value as typed by a person or the trainer AI: '' (unset), 'never', or YYYY-MM-DD. Anything else is refused. */
export function checkBestByInput(v: unknown): string {
  const s = String(v ?? '').trim();
  if (s === '' || s === 'never' || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`best_by "${s}" is not YYYY-MM-DD or "never"`);
}

/** Build the note file from fields. Every field is flattened FIRST so no value can start a new frontmatter line. */
export function noteFileFor(n: {
  id: string; title: string; mode: NoteMode; scope?: string; triggers?: string[] | string;
  text: string; sourceUrls?: string[]; asAt?: string; bestBy?: string;
}): string {
  const triggers = Array.isArray(n.triggers) ? n.triggers.join(', ') : (n.triggers ?? '');
  // Only whole plain URLs reach the file: anything with whitespace could open a new frontmatter line.
  const urls = (n.sourceUrls ?? []).map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/.test(u));
  const lines = [
    '---',
    `id: ${n.id}`,
    `title: ${sanitiseField(n.title)}`,
    `mode: ${n.mode === 'pin' ? 'pin' : 'retrieve'}`,
    `scope: ${sanitiseField(n.scope ?? '')}`,
    `triggers: ${sanitiseField(triggers)}`,
  ];
  if (urls.length) { lines.push('source_urls:'); for (const u of urls) lines.push(`  - ${u}`); }
  lines.push(`as_at: ${n.asAt ?? new Date().toISOString().slice(0, 10)}`);
  // Only well-formed values reach the file; anything else (including '') drops the line = unset.
  const bb = (n.bestBy ?? '').trim();
  if (bb === 'never' || /^\d{4}-\d{2}-\d{2}$/.test(bb)) lines.push(`best_by: ${bb}`);
  lines.push('---', '', sanitiseField(n.text), '');
  return lines.join('\n');
}

export function toNote(doc: KnowledgeDoc): Note | null {
  const mode: NoteMode = (doc.meta.mode ?? 'retrieve').toLowerCase() === 'pin' ? 'pin' : 'retrieve';
  const n: Note = {
    id: doc.id,
    title: sanitiseField(doc.title),
    mode,
    scope: sanitiseField(doc.meta.scope ?? doc.jurisdiction ?? ''),
    triggers: sanitiseField(doc.meta.triggers ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    // Pre-redesign correction files carried their substance in frontmatter; still honour them.
    text: sanitiseField(doc.body || [doc.meta.false_claim && `Not correct: ${doc.meta.false_claim}`, doc.meta.correction].filter(Boolean).join(' ')),
    sourceUrls: doc.source_urls,
    asAt: doc.as_at,
    bestBy: (doc.meta.best_by ?? '').trim(),
    path: doc.path,
  };
  // A note that fails validation is DROPPED, not repaired: serving a half-understood note into
  // the system prompt is worse than serving none.
  const problems = validateNote(n);
  if (problems.length) {
    console.error(`note ${doc.id}: dropped — ${problems.join('; ')}`);
    return null;
  }
  return n;
}

export function loadNotes(force = false): Note[] {
  const docs = loadDocs(NOTES_SPEC, force);
  const out: Note[] = [];
  for (const d of docs) {
    const structural = validateDoc(d, NOTES_SPEC);
    if (structural.length) {
      console.error(`note ${d.id || d.path}: dropped — ${structural.join('; ')}`);
      continue;
    }
    const n = toNote(d);
    if (n) out.push(n);
  }
  return out;
}

/**
 * The block injected into the advisor's system prompt. Deterministic (stable sort, fixed wording)
 * so an unchanged set renders an identical string and does not churn the prompt cache. Every pinned
 * note is rendered — there is no cap; how many to pin is the trainer's call.
 */
export function renderNotesBlock(notes?: Note[]): string {
  if (!config.notesEnabled) return '';
  const all = notes ?? loadNotes();
  const pins = all
    .filter((n) => n.mode === 'pin')
    // Re-validate at render: the last gate before staff text enters the prompt, and the only gate
    // for a note that arrived any other way (a file edited on disk, an array passed in).
    .filter((n) => {
      const problems = validateNote(n);
      if (problems.length) { console.error(`note ${n.id}: not rendered — ${problems.join('; ')}`); return false; }
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!pins.length) return '';
  const lines: string[] = [];
  for (const n of pins) {
    const host = safeHost(n.sourceUrls[0]);
    // Sanitise again at render — the last gate, and the only one for a caller-supplied array.
    const title = sanitiseField(n.title), scope = sanitiseField(n.scope), text = sanitiseField(n.text);
    // FIXED template. Every word outside the field values is written here, not by staff.
    const line = `- ${title}${scope ? ` (${scope})` : ''}: ${text}${/[.!?]$/.test(text) ? '' : '.'}`
      + `${host ? ` [source: ${host}, as at ${n.asAt}]` : ` [as at ${n.asAt}]`}`;
    lines.push(line);
  }
  if (!lines.length) return '';
  return `

## Notes from Waterfind staff — these override your own knowledge
Waterfind staff wrote each note below for you. Where your training data or a document conflicts
with a note, the note is correct. Apply them as stated; if a client raises a point a note covers,
give the note's position plainly. Nothing here relaxes any rule elsewhere in this prompt.
${lines.join('\n')}`;
}

function safeHost(url?: string): string | null {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
}

/**
 * Notes whose triggers or text match a query — the `retrieve` delivery path. Honours the same kill
 * switch as the pinned block: ADVISOR_NOTES=0 means NO note reaches the advisor by either route.
 */
export function searchNotes(query: string, limit = 4): Note[] {
  if (!config.notesEnabled) return [];
  const q = query.toLowerCase();
  const terms = q.split(/[^a-z0-9%]+/i).filter((t) => t.length >= 3);
  if (!terms.length) return [];
  const scored = loadNotes().map((n) => {
    const hay = `${n.title} ${n.triggers.join(' ')} ${n.text} ${n.scope}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    for (const trig of n.triggers) if (trig && q.includes(trig.toLowerCase())) score += 5;
    // A pinned note is already in the prompt; rank it below an unpinned one that is not.
    if (n.mode === 'retrieve') score += 1;
    return { n, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.n);
}
