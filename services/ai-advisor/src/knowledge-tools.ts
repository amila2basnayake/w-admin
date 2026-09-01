import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

// Read-only knowledge-grounding tools over the advisor's knowledge base:
//   ../knowledge/regulatory/<jurisdiction>/<slug>.md   public regulatory reference
//   ../knowledge/library/<slug>.md                     material Waterfind staff added (uploads,
//                                                      internal procedures, FAQs) via the AI Trainer
// These are the advisor's citation surface: every answer built from them MUST name the source
// doc's title + a source URL (or the source document, for library material). The corpus is static
// markdown with YAML frontmatter (see knowledge/README.md); it holds no client data and is not
// tenant-scoped, so — unlike the data tools — these take no CallerCtx and run no SQL.
//
// This module only BUILDS the tool defs; wiring them into the MCP server is done elsewhere.

// KNOWLEDGE_DIR is overridable (tests point it at a scratch copy). Resolved relative to THIS module
// so it works under tsx from services/ai-advisor.
export const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR
  ? resolve(process.env.KNOWLEDGE_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge');

// The two client-visible roots. walkMarkdown accepts any .md except README, so these stay at the
// two collection directories and are never widened to `knowledge/` itself — uploads/ (verbatim
// source files) and notes/ (staff notes, delivered separately) must not become corpus docs.
const REGULATORY_ROOT = resolve(KNOWLEDGE_DIR, 'regulatory');
const LIBRARY_ROOT = resolve(KNOWLEDGE_DIR, 'library');

export type Collection = 'regulatory' | 'library';

export interface KnowledgeDoc {
  id: string;
  title: string;
  jurisdiction: string;
  instrument: string;
  source_urls: string[];
  as_at: string;
  summary: string;
  body: string;      // markdown after the frontmatter block
  path: string;      // absolute path on disk
  /** which collection the loader found it in */
  collection: Collection;
  /**
   * Every other frontmatter key, verbatim. The parser drops unknown keys from the typed fields
   * above; notes need `mode`/`triggers`, library docs `tags`/`source_file`, and they would
   * otherwise need a second parser.
   */
  meta: Record<string, string>;
}

/**
 * A loadable document collection. `regulatory/`, `library/` and `notes/` are specs over one
 * loader — one parser, one cache contract, one validator, rather than a parallel implementation each.
 */
export interface CorpusSpec {
  root: string;
  label: string;
  /** collection tag stamped on every doc loaded from this spec */
  collection: Collection;
  /** frontmatter keys that must be present and non-empty */
  required: string[];
  /** minimum body length; corrections carry their substance in frontmatter, so theirs is 0 */
  minBody: number;
  /** when set, `jurisdiction` must be a member */
  jurisdictions?: Set<string>;
}

// --- minimal YAML frontmatter parser (handles only the flat scalars + the source_urls list this
// corpus uses; deliberately not a general YAML implementation). -----------------------------------
export function parseFrontmatter(raw: string, path: string, collection: Collection = 'regulatory'): KnowledgeDoc | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const [, fm, body] = m;
  const meta: Record<string, string> = {};
  const source_urls: string[] = [];
  const lines = fm.split(/\r?\n/);
  let currentListKey: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey === 'source_urls') {
      source_urls.push(stripQuotes(listItem[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (key === 'source_urls') {
      currentListKey = 'source_urls';
      if (val && val !== '[]') {
        // support inline list form: source_urls: [a, b]
        const inline = val.replace(/^\[|\]$/g, '');
        for (const part of inline.split(',')) {
          const u = stripQuotes(part.trim());
          if (u) source_urls.push(u);
        }
      }
      continue;
    }
    currentListKey = null;
    meta[key] = stripQuotes(val);
  }
  return {
    id: meta.id ?? '',
    title: meta.title ?? '',
    jurisdiction: (meta.jurisdiction ?? '').toUpperCase(),
    instrument: meta.instrument ?? '',
    source_urls,
    as_at: meta.as_at ?? '',
    summary: meta.summary ?? '',
    body: (body ?? '').trim(),
    path,
    collection,
    meta,
  };
}

/**
 * Validate a PARSED doc against its spec. Returns human-readable problems; empty means valid.
 *
 * Aimed at the failure mode this parser actually has. `parseFrontmatter` only returns null when the
 * `---` fences don't match; otherwise unknown keys are dropped and any line that isn't `key: value`
 * is silently skipped — so a prose value wrapped onto a second line loses its tail with no error,
 * and a doc missing a title or source_urls is served rather than rejected. Checking the parsed
 * object catches that; checking that the file "parsed" does not.
 */
export function validateDoc(doc: KnowledgeDoc | null, spec: CorpusSpec): string[] {
  const problems: string[] = [];
  if (!doc) return ['frontmatter block is missing or its --- fences do not match'];
  if (!doc.id) problems.push('id is missing');
  else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(doc.id)) problems.push(`id "${doc.id}" is not kebab-case`);
  for (const key of spec.required) {
    const val = key === 'source_urls' ? (doc.source_urls.length ? 'y' : '') : (doc as any)[key] ?? doc.meta[key];
    if (!val || !String(val).trim()) problems.push(`${key} is missing or empty`);
  }
  // Any source_url present must be a plain http(s) URL, whichever collection: these are rendered as
  // links in the Trainer page and quoted to clients, so a javascript: or data: value is never allowed.
  for (const u of doc.source_urls) {
    if (!/^https?:\/\/\S+$/.test(u)) problems.push(`source_url is not a plain http(s) URL: ${u}`);
  }
  if (spec.required.includes('as_at') && doc.as_at && !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_at)) {
    problems.push(`as_at "${doc.as_at}" is not YYYY-MM-DD`);
  }
  // best_by (optional, any collection): when this date passes the item is re-verified by the
  // auto-refresh; "never" opts it out ("never goes stale").
  if (doc.meta.best_by && doc.meta.best_by !== 'never' && !/^\d{4}-\d{2}-\d{2}$/.test(doc.meta.best_by)) {
    problems.push(`best_by "${doc.meta.best_by}" is not YYYY-MM-DD or "never"`);
  }
  if (spec.jurisdictions && !spec.jurisdictions.has(doc.jurisdiction)) {
    problems.push(`jurisdiction "${doc.jurisdiction}" is not one of ${[...spec.jurisdictions].join(', ')}`);
  }
  if (doc.body.length < spec.minBody) {
    problems.push(`body is too short (${doc.body.length} chars, need >= ${spec.minBody})`);
  }
  return problems;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}

// --- corpus loading (lazy, cached, hot-reloading) -------------------------------------------------
//
// The AI Trainer writes into these directories UNDER a long-running sidecar, so the load path has
// the same obligations as snapshot-cache.ts: notice changes without a restart, and never let a
// half-written or vanished file take the advisor down.
//
//  - Guarded stat per entry. A file can disappear between readdir and stat (the publisher's
//    rename, an archive move, a developer's `git checkout`); an unguarded statSync threw ENOENT out
//    of every tool call until the tree settled.
//  - Last-good fallback. The cache used to be assigned only on success, so a mid-load failure left
//    NO corpus at all rather than the previous one.
//  - Reload keys off a signature (path + mtime + size of every file), not a directory stat: a
//    directory's mtime does not change when a file's CONTENT changes, and additions/removals must
//    be noticed too. ~35 stats per access, the same order as the snapshot readers.

interface CorpusCache {
  docs: KnowledgeDoc[];
  signature: string;
}
const CACHES = new Map<string, CorpusCache>();

interface WalkEntry { path: string; mtimeMs: number; size: number }

function rootExists(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

function walkMarkdown(dir: string): WalkEntry[] {
  const out: WalkEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;   // missing/unreadable directory is not an error: an empty collection
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;   // vanished between readdir and stat — skip it, do not fail the whole load
    }
    if (st.isDirectory()) {
      // `.staging` is where the publisher writes before renaming into place; never load from it.
      if (name.startsWith('.')) continue;
      out.push(...walkMarkdown(full));
    } else if (name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md') {
      out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

/** Load a document collection, re-reading only when the files on disk actually changed. */
export function loadDocs(spec: CorpusSpec, force = false): KnowledgeDoc[] {
  const cached = CACHES.get(spec.root);
  let entries: WalkEntry[];
  try {
    entries = walkMarkdown(spec.root);
  } catch (e) {
    if (cached) return cached.docs;
    console.error(`knowledge ${spec.label}: walk failed and no cached copy`, e);
    return [];
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const signature = entries.map((e) => `${e.path}:${e.mtimeMs}:${e.size}`).join('|');
  if (cached && !force && cached.signature === signature) return cached.docs;

  const docs: KnowledgeDoc[] = [];
  try {
    for (const entry of entries) {
      let raw: string;
      try {
        raw = readFileSync(entry.path, 'utf8');
      } catch {
        continue;   // vanished mid-load; the next access re-reads
      }
      const doc = parseFrontmatter(raw, entry.path, spec.collection);
      // `status: archived` (a pre-redesign retirement marker) still hides a doc from the advisor.
      if (doc && doc.id && (doc.meta.status ?? '').toLowerCase() !== 'archived') docs.push(doc);
    }
  } catch (e) {
    if (cached) {
      console.error(`knowledge ${spec.label}: reload failed, serving last good copy`, e);
      return cached.docs;
    }
    console.error(`knowledge ${spec.label}: initial load failed`, e);
    return [];
  }
  docs.sort((a, b) => a.id.localeCompare(b.id));
  if (cached && docs.length === 0 && cached.docs.length > 0 && !rootExists(spec.root)) {
    // The root directory itself vanished (a checkout mid-switch, an unmounted volume): a filesystem
    // problem, not an edit — keep serving the last good copy. A root that exists and is simply empty
    // is legitimate: the trainer may have deleted the last document or note in a collection.
    console.error(`knowledge ${spec.label}: root missing and loaded 0 docs but had ${cached.docs.length}; keeping last good copy`);
    return cached.docs;
  }
  CACHES.set(spec.root, { docs, signature });
  if (!cached || cached.docs.length !== docs.length) {
    console.log(`knowledge ${spec.label}: loaded ${docs.length} docs`);
  }
  return docs;
}

export const JURISDICTION_SET = new Set(['CTH', 'NSW', 'VIC', 'SA', 'QLD', 'WA', 'TAS', 'CROSS']);

export const REGULATORY_SPEC: CorpusSpec = {
  root: REGULATORY_ROOT,
  label: 'regulatory',
  collection: 'regulatory',
  required: ['id', 'title', 'jurisdiction', 'instrument', 'source_urls', 'as_at', 'summary'],
  minBody: 200,
  jurisdictions: JURISDICTION_SET,
};

/**
 * Library documents are material Waterfind staff added: an uploaded PDF/DOCX kept verbatim under an
 * AI-written annotation, an internal procedure, an FAQ. Sources are files rather than URLs, so
 * source_urls is optional; jurisdiction is free-form (validated only when present).
 */
export const LIBRARY_SPEC: CorpusSpec = {
  root: LIBRARY_ROOT,
  label: 'library',
  collection: 'library',
  required: ['id', 'title', 'as_at', 'summary'],
  minBody: 20,
};

/** Every document the advisor may cite: both collections, one list, sorted by id. */
export function loadCorpus(force = false): KnowledgeDoc[] {
  const reg = loadDocs(REGULATORY_SPEC, force);
  const lib = loadDocs(LIBRARY_SPEC, force);
  if (!lib.length) return reg;
  return [...reg, ...lib].sort((a, b) => a.id.localeCompare(b.id));
}

// --- keyword/phrase scoring ----------------------------------------------------------------------
function terms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9%]+/i)
        .filter((t) => t.length >= 2),
    ),
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

interface Scored {
  doc: KnowledgeDoc;
  score: number;
  excerpts: string[];
}

function scoreDoc(doc: KnowledgeDoc, query: string, ts: string[]): Scored {
  const phrase = query.trim().toLowerCase();
  const title = doc.title.toLowerCase();
  const id = doc.id.toLowerCase();
  const summary = doc.summary.toLowerCase();
  const instrument = doc.instrument.toLowerCase();
  const body = doc.body.toLowerCase();
  let score = 0;
  for (const t of ts) {
    if (title.includes(t)) score += 8;
    if (id.includes(t)) score += 5;
    if (summary.includes(t)) score += 4;
    if (instrument.includes(t)) score += 4;
    score += Math.min(countOccurrences(body, t), 8); // body: 1 each, capped
  }
  if (phrase.length >= 4) {
    if (title.includes(phrase)) score += 20;
    if (body.includes(phrase)) score += 10;
    if (summary.includes(phrase)) score += 6;
  }
  return { doc, score, excerpts: excerptsFor(doc, ts) };
}

function excerptsFor(doc: KnowledgeDoc, ts: string[]): string[] {
  const body = doc.body;
  const lower = body.toLowerCase();
  const out: string[] = [];
  const seen = new Set<number>();
  for (const t of ts) {
    const idx = lower.indexOf(t);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 90);
    const end = Math.min(body.length, idx + t.length + 130);
    // avoid near-duplicate windows
    const bucket = Math.floor(start / 60);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    let snip = body.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snip = '…' + snip;
    if (end < body.length) snip = snip + '…';
    out.push(snip);
    if (out.length >= 3) break;
  }
  if (out.length === 0 && doc.summary) out.push(doc.summary);
  return out;
}

// --- tool defs -----------------------------------------------------------------------------------
function J(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

const JURISDICTIONS = ['CTH', 'NSW', 'VIC', 'SA', 'QLD', 'WA', 'TAS', 'CROSS'] as const;

const jurisdictionArg = z
  .enum(JURISDICTIONS)
  .optional()
  .describe(
    'optional filter: CTH (Commonwealth: Water Act 2007, Basin Plan 2012), NSW, VIC, SA, QLD, WA, ' +
      'TAS, or CROSS (interstate/inter-valley trade mechanics + jurisdiction comparison tables)',
  );

const CITE =
  'Documents carry `title`, `jurisdiction`, `instrument`, `source_urls`, an `as_at` date and a ' +
  '`collection`: "regulatory" (public instruments — cite title + a source URL) or "library" ' +
  '(material Waterfind staff added, e.g. an internal procedure or an uploaded report kept in full ' +
  'under a summary — cite the document title and, where given, `source_file`). ' +
  'The corpus does not cover every jurisdiction or topic — see the `corpus-coverage` manifest doc; ' +
  'a zero-match search means the topic is not in the corpus, not that no rule exists. The corpus ' +
  'contains no client data, live allocations or live prices (the data tools hold those).';

/** Largest slice of a document body returned per call — long library documents (verbatim uploads) are paged. */
export const DOC_PAGE_MAX = 60_000;

export const KNOWLEDGE_TOOL_NAMES = [
  'search_knowledge', 'get_knowledge_doc', 'list_knowledge_docs',
] as const;

/**
 * A staff note, structurally typed here so this module does not import notes.ts (which imports
 * this one). The provider is injected by the caller instead.
 */
export interface NoteLite {
  id: string;
  title: string;
  scope: string;
  text: string;
  sourceUrls: string[];
  asAt: string;
}

export interface KnowledgeToolOpts {
  /** Surfaces staff notes alongside search hits — the `retrieve` delivery path. */
  searchNotes?: (query: string, limit?: number) => NoteLite[];
}

export function buildKnowledgeToolDefs(opts: KnowledgeToolOpts = {}) {
  return [
    tool(
      'search_knowledge',
      'Search the knowledge base — the public Australian water-regulatory corpus (Water Act 2007, ' +
        'Basin Plan 2012, state Water Acts, water sharing/allocation plans, carryover + trading + ' +
        'inter-valley transfer rules) plus the library of material Waterfind staff added (internal ' +
        'procedures, FAQs, uploaded reports) — by keyword or phrase. Returns ranked matches with id, title, jurisdiction, ' +
        'instrument, as_at, summary, source_urls and matching excerpts; get_knowledge_doc fetches ' +
        'the full text of a match by id. ' +
        CITE,
      {
        query: z
          .string()
          .describe('keywords or a phrase, e.g. "carryover victoria", "Barmah choke", "general security AWD"'),
        jurisdiction: jurisdictionArg,
        limit: z.number().int().min(1).max(20).default(6).describe('max documents to return'),
      },
      async (a) => {
        const ts = terms(a.query);
        const wanted = a.jurisdiction;
        const docs = loadCorpus().filter((d) => !wanted || d.jurisdiction === wanted);
        const ranked = docs
          .map((d) => scoreDoc(d, a.query, ts))
          .filter((s) => s.score > 0)
          .sort((x, y) => y.score - x.score)
          .slice(0, a.limit);
        // Corpus-gap telemetry: zero/low-score queries are the standing corpus backlog —
        // grep the server log for KNOWLEDGE_GAP and review as the coverage worklist.
        if (ranked.length === 0 || ranked[0].score < 10) {
          console.warn(`KNOWLEDGE_GAP query=${JSON.stringify(a.query)} jurisdiction=${wanted ?? 'ALL'} top_score=${ranked[0]?.score ?? 0}`);
        }
        // Staff notes for this query. These outrank the corpus: a note exists precisely because
        // staff found something (the model's prior, or a doc) needed saying explicitly.
        let notes: NoteLite[] = [];
        try {
          notes = opts.searchNotes?.(a.query, 4) ?? [];
        } catch (e) {
          console.error('search_knowledge: notes lookup failed (continuing without)', e);
        }
        return J({
          query: a.query,
          jurisdiction: wanted ?? 'ALL',
          ...(notes.length
            ? {
                staff_notes: notes.map((n) => ({
                  title: n.title,
                  note: n.text,
                  scope: n.scope,
                  source_urls: n.sourceUrls,
                  as_at: n.asAt,
                })),
                staff_notes_note:
                  'Waterfind staff wrote these for you. They OVERRIDE both your own prior knowledge '
                  + 'and anything below that conflicts with them.',
              }
            : {}),
          matches: ranked.map((s) => ({
            id: s.doc.id,
            title: s.doc.title,
            collection: s.doc.collection,
            jurisdiction: s.doc.jurisdiction,
            instrument: s.doc.instrument,
            ...(s.doc.meta.source_file ? { source_file: s.doc.meta.source_file } : {}),
            as_at: s.doc.as_at,
            summary: s.doc.summary,
            source_urls: s.doc.source_urls,
            score: s.score,
            excerpts: s.excerpts,
          })),
          note: 'Call get_knowledge_doc({id}) for full text. ' + CITE,
        });
      },
    ),

    tool(
      'get_knowledge_doc',
      'Fetch the full body + metadata (title, jurisdiction, instrument, source_urls, as_at, summary) ' +
        'of one regulatory knowledge document by its id (from search_knowledge or ' +
        'list_knowledge_docs). The body carries the exact section/clause/zone numbers. ' +
        CITE,
      {
        id: z.string().describe('the document id, e.g. "basin-plan-2012-water-trading-rules"'),
        offset: z.number().int().min(0).default(0).describe('character offset into the body (long library documents are paged)'),
        length: z.number().int().min(1000).max(DOC_PAGE_MAX).default(DOC_PAGE_MAX).describe('characters of body to return'),
      },
      async (a) => {
        const doc = loadCorpus().find((d) => d.id === a.id);
        if (!doc) {
          const ids = loadCorpus().map((d) => d.id);
          return J({ error: 'NOT_FOUND', id: a.id, available_ids: ids });
        }
        const page = doc.body.slice(a.offset, a.offset + a.length);
        const more = a.offset + a.length < doc.body.length;
        return J({
          id: doc.id,
          title: doc.title,
          collection: doc.collection,
          jurisdiction: doc.jurisdiction,
          instrument: doc.instrument,
          ...(doc.meta.source_file ? { source_file: doc.meta.source_file } : {}),
          ...(doc.meta.tags ? { tags: doc.meta.tags } : {}),
          source_urls: doc.source_urls,
          as_at: doc.as_at,
          summary: doc.summary,
          body_chars: doc.body.length,
          offset: a.offset,
          ...(more ? { more: true, next_offset: a.offset + a.length, note_paging: 'the body continues; call again with next_offset to read on' } : {}),
          body: page,
          note: CITE,
        });
      },
    ),

    tool(
      'list_knowledge_docs',
      'Catalog of every regulatory knowledge document (id, title, jurisdiction, instrument, summary, ' +
        'as_at), optionally filtered by jurisdiction. Shows what the corpus covers. ' +
        CITE,
      { jurisdiction: jurisdictionArg },
      async (a) => {
        const wanted = a.jurisdiction;
        const docs = loadCorpus().filter((d) => !wanted || d.jurisdiction === wanted);
        return J({
          jurisdiction: wanted ?? 'ALL',
          count: docs.length,
          docs: docs.map((d) => ({
            id: d.id,
            title: d.title,
            collection: d.collection,
            jurisdiction: d.jurisdiction,
            instrument: d.instrument,
            summary: d.summary,
            as_at: d.as_at,
          })),
          note: CITE,
        });
      },
    ),
  ];
}
