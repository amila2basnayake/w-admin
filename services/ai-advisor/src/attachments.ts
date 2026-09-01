import crypto from 'node:crypto';
import { query } from './db';
import { NotFound } from './conversations';

// ---- limits & accepted types -------------------------------------------------

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/** Combined caps for ONE message — keeps a turn inside the API request/context limits. */
export const MAX_MESSAGE_BINARY_BYTES = 16 * 1024 * 1024;
export const MAX_MESSAGE_TEXT_BYTES = 512 * 1024;
/**
 * Byte budget for re-embedding raw attachment content (binary + text) when rebuilding a
 * fresh-session prompt.
 *
 * INVARIANT: this budget trims OLDER history ONLY. The CURRENT turn's attachments are ALWAYS
 * embedded in full, exempt from this budget (see `selectPromptEmbeds` / `formatFreshPromptContent`).
 * So any message that passed upload validation (<= MAX_MESSAGE_BINARY_BYTES binary +
 * MAX_MESSAGE_TEXT_BYTES text) can always be presented whole on its own turn — it can never be
 * replaced by a "please re-attach" placeholder, which would be un-actionable (re-uploading would
 * just re-hit the same budget, an infinite loop). Kept >= one full message's caps so the two
 * limits stay consistent and the most recent PRIOR message can also embed whole.
 */
export const PROMPT_EMBED_BUDGET_BYTES = MAX_MESSAGE_BINARY_BYTES + MAX_MESSAGE_TEXT_BYTES;
/** Upload backstop: a user may not hoard never-sent uploads (storage DoS). */
export const MAX_UNBOUND_PER_USER = 20;

const MB = 1024 * 1024;
const KB = 1024;

export type AttachmentKind = 'image' | 'pdf' | 'text';

interface TypeRule { kind: AttachmentKind; mime: string; maxBytes: number; }

// Extension is the user's declaration; magic bytes are the authority (checked below).
const EXT_RULES: Record<string, TypeRule> = {
  png:  { kind: 'image', mime: 'image/png',  maxBytes: 5 * MB },
  jpg:  { kind: 'image', mime: 'image/jpeg', maxBytes: 5 * MB },
  jpeg: { kind: 'image', mime: 'image/jpeg', maxBytes: 5 * MB },
  gif:  { kind: 'image', mime: 'image/gif',  maxBytes: 5 * MB },
  webp: { kind: 'image', mime: 'image/webp', maxBytes: 5 * MB },
  pdf:  { kind: 'pdf',   mime: 'application/pdf', maxBytes: 10 * MB },
  // Text is INLINED into the prompt (~4 bytes/token) — 256 KB is already ~65k tokens.
  csv:  { kind: 'text',  mime: 'text/csv',        maxBytes: 256 * KB },
  tsv:  { kind: 'text',  mime: 'text/tab-separated-values', maxBytes: 256 * KB },
  txt:  { kind: 'text',  mime: 'text/plain',      maxBytes: 256 * KB },
  log:  { kind: 'text',  mime: 'text/plain',      maxBytes: 256 * KB },
  md:   { kind: 'text',  mime: 'text/markdown',   maxBytes: 256 * KB },
  json: { kind: 'text',  mime: 'application/json', maxBytes: 256 * KB },
  xml:  { kind: 'text',  mime: 'application/xml',  maxBytes: 256 * KB },
};

export const ACCEPT_EXTENSIONS = Object.keys(EXT_RULES); // surfaced to the UI's file picker

export class BadAttachment extends Error {
  constructor(msg: string) { super(msg); this.name = 'BadAttachment'; }
}

// ---- validation ----------------------------------------------------------------

/** Magic-byte sniff for the binary kinds. Returns the real mime, or null if unrecognised. */
function sniffBinary(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

function decodeUtf8Strict(buf: Buffer): string {
  if (buf.includes(0)) throw new BadAttachment('text file contains binary data');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new BadAttachment('text file is not valid UTF-8');
  }
}

export interface ValidatedUpload { filename: string; mime: string; kind: AttachmentKind; }

/**
 * Validate an upload by declared filename + actual bytes. The extension picks the rule;
 * magic bytes must agree for image/pdf; text must be clean UTF-8. Throws BadAttachment.
 */
export function validateUpload(rawFilename: string, buf: Buffer): ValidatedUpload {
  const filename = (rawFilename || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 200);
  if (!filename) throw new BadAttachment('missing filename');
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const rule = EXT_RULES[ext];
  if (!rule) throw new BadAttachment(`file type .${ext || '?'} is not supported (allowed: ${ACCEPT_EXTENSIONS.join(', ')})`);
  if (!buf.length) throw new BadAttachment('empty file');
  if (buf.length > rule.maxBytes) {
    const human = rule.maxBytes >= MB ? `${Math.round(rule.maxBytes / MB)} MB` : `${Math.round(rule.maxBytes / KB)} KB`;
    throw new BadAttachment(`${rule.kind} files are limited to ${human}`);
  }
  if (rule.kind === 'text') {
    decodeUtf8Strict(buf);
  } else {
    const sniffed = sniffBinary(buf);
    if (sniffed !== rule.mime && !(rule.kind === 'image' && sniffed?.startsWith('image/'))) {
      throw new BadAttachment(`file content does not match .${ext} (${sniffed ?? 'unrecognised format'})`);
    }
    if (sniffed && sniffed !== rule.mime) return { filename, mime: sniffed, kind: rule.kind };
  }
  return { filename, mime: rule.mime, kind: rule.kind };
}

// ---- persistence ----------------------------------------------------------------

export interface AttachmentMeta {
  id: number;
  user_id: number;
  conversation_id: number | null;
  message_id: number | null;
  filename: string;
  mime: string;
  kind: AttachmentKind;
  size_bytes: number;
  created_at: string;
}
export interface AttachmentRow extends AttachmentMeta { data: Buffer; }

const META_COLS = 'id, user_id, conversation_id, message_id, filename, mime, kind, size_bytes, created_at';

export async function insertAttachment(userId: number, v: ValidatedUpload, buf: Buffer): Promise<AttachmentMeta> {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const r = await query<AttachmentMeta>(
    `INSERT INTO attachment (user_id, filename, mime, kind, size_bytes, sha256, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${META_COLS}`,
    [userId, v.filename, v.mime, v.kind, buf.length, sha256, buf],
  );
  return r.rows[0];
}

/** Opportunistic global sweep: never-sent uploads older than a day (any user's). */
export async function sweepUnboundAttachments(): Promise<void> {
  await query(`DELETE FROM attachment WHERE message_id IS NULL AND created_at < now() - interval '24 hours'`);
}

/** Backstop against storage DoS: refuse the upload if the user is hoarding unsent files. */
export async function assertUnboundHeadroom(userId: number): Promise<void> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM attachment WHERE user_id = $1 AND message_id IS NULL`,
    [userId],
  );
  if ((r.rows[0]?.n ?? 0) >= MAX_UNBOUND_PER_USER) {
    throw new BadAttachment('too many unsent uploads — send or wait for old ones to expire');
  }
}

export async function getOwnedAttachment(id: number, userId: number): Promise<AttachmentRow> {
  const r = await query<AttachmentRow>(
    `SELECT ${META_COLS}, data FROM attachment WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (r.rowCount === 0) throw new NotFound('attachment not found');
  return r.rows[0];
}

/**
 * Resolve the attachments a message wants to send. Each must be the caller's and either
 * never sent, or already bound to THIS conversation (edit/regenerate re-use). Order follows ids.
 */
export async function claimAttachments(ids: number[], userId: number, conversationId: number): Promise<AttachmentRow[]> {
  if (!ids.length) return [];
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new BadAttachment(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
  }
  const r = await query<AttachmentRow>(
    `SELECT ${META_COLS}, data FROM attachment WHERE id = ANY($1) AND user_id = $2`,
    [ids, userId],
  );
  const byId = new Map(r.rows.map((a) => [a.id, a]));
  const claimed = ids.map((id) => {
    const a = byId.get(id);
    if (!a) throw new NotFound('attachment not found');
    if (a.conversation_id != null && a.conversation_id !== conversationId) {
      throw new BadAttachment('attachment belongs to another conversation');
    }
    return a;
  });
  // Combined per-message caps so one turn can never exceed API request/context limits.
  const sum = (kindTest: (k: AttachmentKind) => boolean) =>
    claimed.reduce((n, a) => n + (kindTest(a.kind) ? a.size_bytes : 0), 0);
  if (sum((k) => k !== 'text') > MAX_MESSAGE_BINARY_BYTES) {
    throw new BadAttachment(`images/PDFs on one message are limited to ${MAX_MESSAGE_BINARY_BYTES / MB} MB combined`);
  }
  if (sum((k) => k === 'text') > MAX_MESSAGE_TEXT_BYTES) {
    throw new BadAttachment(`text files on one message are limited to ${MAX_MESSAGE_TEXT_BYTES / KB} KB combined`);
  }
  return claimed;
}

/**
 * Owner-scoped bind. Only unbound rows or rows already in this conversation may move
 * (a concurrent message that claimed the same upload loses — rowcount reveals it).
 */
export async function bindAttachments(ids: number[], userId: number, conversationId: number, messageId: number): Promise<void> {
  if (!ids.length) return;
  const r = await query(
    `UPDATE attachment SET conversation_id = $2, message_id = $3
      WHERE id = ANY($1) AND user_id = $4 AND (message_id IS NULL OR conversation_id = $2)`,
    [ids, conversationId, messageId, userId],
  );
  if (r.rowCount !== ids.length) throw new BadAttachment('attachment was claimed by another message');
}

/** Attachment metadata (no bytes) for a set of messages — for fresh-session prompt rebuilds. */
export async function attachmentsForMessages(messageIds: number[], userId: number): Promise<Map<number, AttachmentMeta[]>> {
  const map = new Map<number, AttachmentMeta[]>();
  if (!messageIds.length) return map;
  const r = await query<AttachmentMeta>(
    `SELECT ${META_COLS} FROM attachment
      WHERE message_id = ANY($1) AND user_id = $2 ORDER BY id`,
    [messageIds, userId],
  );
  for (const a of r.rows) {
    const list = map.get(a.message_id!) ?? [];
    list.push(a);
    map.set(a.message_id!, list);
  }
  return map;
}

/** Bytes for exactly the attachments a rebuild decided to embed. */
export async function loadAttachmentData(ids: number[], userId: number): Promise<Map<number, Buffer>> {
  const map = new Map<number, Buffer>();
  if (!ids.length) return map;
  const r = await query<{ id: number; data: Buffer }>(
    `SELECT id, data FROM attachment WHERE id = ANY($1) AND user_id = $2`,
    [ids, userId],
  );
  for (const row of r.rows) map.set(row.id, row.data);
  return map;
}

/**
 * Decide which attachments to embed when rebuilding a fresh-session prompt, given each active
 * message's attachment list in conversation order (oldest -> newest). Returns the ids to embed.
 *
 * The CURRENT turn — the newest/last message, the one being answered — is ALWAYS embedded in
 * full (exempt from the budget): its attachments passed upload validation, so they fit within
 * one turn's caps by construction and must never be dropped to a "please re-attach" placeholder.
 * The PROMPT_EMBED_BUDGET_BYTES budget then trims OLDER history, walking newest-first; whatever
 * doesn't fit is left out for the caller to render as a placeholder (a legitimate path for real
 * history, never for the current turn).
 */
export function selectPromptEmbeds(perMessage: AttachmentMeta[][]): Set<number> {
  const embed = new Set<number>();
  if (!perMessage.length) return embed;
  const currentIdx = perMessage.length - 1;
  // Current turn: always embed, unconditionally (see the invariant on PROMPT_EMBED_BUDGET_BYTES).
  for (const a of perMessage[currentIdx]) embed.add(a.id);
  // Older history only: newest-first, mixed binary + text share one byte budget.
  let budget = PROMPT_EMBED_BUDGET_BYTES;
  for (let i = currentIdx - 1; i >= 0; i--) {
    for (const a of perMessage[i]) {
      if (a.size_bytes <= budget) { embed.add(a.id); budget -= a.size_bytes; }
    }
  }
  return embed;
}

/** The subset of metadata stored on the message row and shown to the UI. */
export function publicMeta(a: AttachmentMeta) {
  return { id: a.id, filename: a.filename, mime: a.mime, kind: a.kind, size_bytes: a.size_bytes };
}

// ---- prompt content blocks -------------------------------------------------------

export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };

/**
 * Content blocks for one attachment. Text files are inlined with explicit framing so the
 * model treats them as quoted user DATA (see ATTACHMENTS_HINT); images/PDFs become native
 * blocks. Pass `data: null` to emit a placeholder instead (rebuilt history over budget).
 */
export function attachmentBlocks(a: AttachmentMeta, data: Buffer | null): PromptBlock[] {
  if (data == null) {
    return [{ type: 'text', text: `[${a.kind === 'image' ? 'Image' : 'File'} attached: ${a.filename} — content not re-sent in this rebuilt context]` }];
  }
  if (a.kind === 'text') {
    // Neutralise any attempt to close our framing tag from inside the file (prompt injection).
    const body = data.toString('utf8').replace(/<(\/?\s*user_uploaded_file)/gi, '&lt;$1');
    return [{
      type: 'text',
      text: `<user_uploaded_file name="${a.filename}" type="${a.mime}">\n${body}\n</user_uploaded_file>`,
    }];
  }
  if (a.kind === 'pdf') {
    return [
      { type: 'text', text: `[Attached PDF: ${a.filename}]` },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') }, title: a.filename },
    ];
  }
  return [
    { type: 'text', text: `[Attached image: ${a.filename}]` },
    { type: 'image', source: { type: 'base64', media_type: a.mime, data: data.toString('base64') } },
  ];
}
