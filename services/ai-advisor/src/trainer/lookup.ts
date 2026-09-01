import { query } from '../db';
import { TrainerError } from './store';
import type { TrainerIdentity } from './auth';

/**
 * Advisor conversation lookup for the Trainer surface — the tool that lets the trainer AI (and the
 * Reports view) find "the chat where the advisor told Smith the wrong carryover limit" and read it.
 *
 * ONLY the Trainer has this. The client-facing advisor's tools cannot reach other users'
 * conversations, and nothing here is registered with it. Client chats carry holdings, prices and
 * personal circumstances, so every transcript read is written to kb_access_log with who read it,
 * why, and whether the AI or a person asked.
 */

export interface ConversationHit {
  id: number; title: string; started_at: string; last_at: string; messages: number;
  client_uid: number | null; client_name: string | null; staff_uid: number | null; staff_name: string | null;
  kind: 'client' | 'broker-assist'; first_question: string | null; matched_excerpt: string | null;
}

export interface FindOpts {
  clientName?: string; userId?: number; text?: string; from?: string; to?: string; limit?: number;
  conversationId?: number;
}

/**
 * Who is searching, for kb_access_log. A search result already shows client content (the first
 * question, a matched excerpt), so a search is logged like a read: one row per conversation returned,
 * purpose = the search terms. Omit only for internal lookups that log on their own (readConversation).
 */
export interface SearchLog { reader: TrainerIdentity; byAgent: boolean }

const NAME_SQL = `COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.username)`;

function describeSearch(o: FindOpts): string {
  const parts: string[] = [];
  if (o.clientName) parts.push(`client="${o.clientName.trim()}"`);
  if (o.userId) parts.push(`user_id=${o.userId}`);
  if (o.text) parts.push(`text="${o.text.trim()}"`);
  if (o.from) parts.push(`from=${o.from}`);
  if (o.to) parts.push(`to=${o.to}`);
  return `search ${parts.join(' ')}`.slice(0, 200);
}

export async function findConversations(o: FindOpts, log?: SearchLog): Promise<ConversationHit[]> {
  const hits = await queryConversations(o);
  if (log && hits.length) {
    const purpose = describeSearch(o);
    await query(
      `INSERT INTO kb_access_log (reader_user_id, conversation_id, purpose, by_agent)
       SELECT $1, unnest($2::bigint[]), $3, $4`,
      [log.reader.userId, hits.map((h) => h.id), purpose, log.byAgent]);
  }
  return hits;
}

async function queryConversations(o: FindOpts): Promise<ConversationHit[]> {
  const where: string[] = []; const args: unknown[] = [];
  const add = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (o.conversationId) where.push(`c.id = ${add(o.conversationId)}`);
  if (o.userId) where.push(`(c.user_id = ${add(o.userId)} OR c.assist_client_uid = ${add(o.userId)})`);
  if (o.clientName?.trim()) {
    const like = `%${o.clientName.trim().replace(/[%_\\]/g, ' ')}%`;
    // Match the client of the chat: the owner for a client chat, the subject for a broker-assist chat.
    where.push(`EXISTS (SELECT 1 FROM waterfind_user u
                          WHERE u.id = COALESCE(c.assist_client_uid, c.user_id)
                            AND (u.first_name ILIKE ${add(like)} OR u.last_name ILIKE ${add(like)}
                                 OR (COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) ILIKE ${add(like)}
                                 OR u.username ILIKE ${add(like)} OR u.email ILIKE ${add(like)}))`);
  }
  let excerptSql = 'NULL::text';
  if (o.text?.trim()) {
    const like = `%${o.text.trim().replace(/[%_\\]/g, ' ')}%`;
    where.push(`EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = c.id AND m.active AND m.content ILIKE ${add(like)})`);
    excerptSql = `(SELECT substr(m.content, GREATEST(1, position(lower(${add(o.text.trim())}) in lower(m.content)) - 80), 240)
                    FROM message m WHERE m.conversation_id = c.id AND m.active AND m.content ILIKE ${add(like)} ORDER BY m.id LIMIT 1)`;
  }
  const iso = (v: string, what: string) => { const d = new Date(v); if (Number.isNaN(d.getTime())) throw new TrainerError(`${what} is not a valid date`); return d.toISOString(); };
  if (o.from) where.push(`c.updated_at >= ${add(iso(o.from, 'from'))}`);
  if (o.to) where.push(`c.updated_at <= ${add(iso(o.to, 'to'))}`);
  const limit = Math.min(Math.max(o.limit ?? 20, 1), 100);
  const r = await query(
    `SELECT c.id, c.title, c.created_at, c.updated_at, c.user_id, c.assist_client_uid, c.assist_staff_name,
            (SELECT ${NAME_SQL} FROM waterfind_user u WHERE u.id = COALESCE(c.assist_client_uid, c.user_id)) AS client_name,
            (SELECT count(*) FROM message m WHERE m.conversation_id = c.id AND m.active)::int AS n,
            (SELECT substr(m.content, 1, 200) FROM message m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.active ORDER BY m.id LIMIT 1) AS first_q,
            ${excerptSql} AS excerpt
       FROM conversation c
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.updated_at DESC LIMIT ${add(limit)}`, args);
  return (r.rows as any[]).map((row) => ({
    id: Number(row.id), title: row.title, started_at: row.created_at, last_at: row.updated_at, messages: row.n,
    client_uid: Number(row.assist_client_uid ?? row.user_id), client_name: row.client_name ?? null,
    staff_uid: row.assist_client_uid ? Number(row.user_id) : null, staff_name: row.assist_staff_name ?? null,
    kind: row.assist_client_uid ? 'broker-assist' : 'client',
    first_question: row.first_q ?? null, matched_excerpt: row.excerpt ?? null,
  }));
}

export interface TranscriptMessage { id: number; role: string; content: string; at: string; reported?: string | null }

export interface Transcript {
  conversation: ConversationHit; messages: TranscriptMessage[]; truncated: boolean;
  reports: { feedback_id: number; message_id: number | null; body: string | null; at: string }[];
}

const MSG_CHAR_CAP = 6000;

/** Read a conversation. Logged. `aroundMessageId` centres the window on one message. */
export async function readConversation(
  id: number, reader: TrainerIdentity, purpose: string, byAgent: boolean,
  opts: { limit?: number; aroundMessageId?: number } = {},
): Promise<Transcript> {
  const [conv] = await queryConversations({ conversationId: id, limit: 1 });   // logged below, as a read
  if (!conv) throw new TrainerError(`no conversation #${id}`, 404);
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  let rows: any[];
  if (opts.aroundMessageId) {
    const before = await query(`SELECT id, role, content, created_at FROM message WHERE conversation_id = $1 AND active AND id <= $2 ORDER BY id DESC LIMIT $3`,
      [id, opts.aroundMessageId, Math.ceil(limit / 2)]);
    const after = await query(`SELECT id, role, content, created_at FROM message WHERE conversation_id = $1 AND active AND id > $2 ORDER BY id ASC LIMIT $3`,
      [id, opts.aroundMessageId, Math.floor(limit / 2)]);
    rows = [...(before.rows as any[]).reverse(), ...(after.rows as any[])];
  } else {
    const r = await query(`SELECT id, role, content, created_at FROM message WHERE conversation_id = $1 AND active ORDER BY id DESC LIMIT $2`, [id, limit + 1]);
    rows = (r.rows as any[]).reverse();
  }
  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(rows.length - limit);
  const fb = await query(`SELECT id, message_id, body, created_at FROM feedback WHERE conversation_id = $1 AND kind = 'inaccuracy' ORDER BY id`, [id]);
  const reportedBy = new Map<number, string>();
  for (const f of fb.rows as any[]) if (f.message_id) reportedBy.set(Number(f.message_id), f.body ?? '(no comment)');
  await query(`INSERT INTO kb_access_log (reader_user_id, conversation_id, message_id, purpose, by_agent) VALUES ($1,$2,$3,$4,$5)`,
    [reader.userId, id, opts.aroundMessageId ?? null, purpose.slice(0, 200), byAgent]);
  return {
    conversation: conv,
    messages: rows.map((m) => ({
      id: Number(m.id), role: m.role, at: m.created_at,
      content: m.content.length > MSG_CHAR_CAP ? m.content.slice(0, MSG_CHAR_CAP) + ' […]' : m.content,
      reported: reportedBy.get(Number(m.id)) ?? null,
    })),
    truncated,
    reports: (fb.rows as any[]).map((f) => ({ feedback_id: Number(f.id), message_id: f.message_id ? Number(f.message_id) : null, body: f.body, at: f.created_at })),
  };
}

// --- inaccuracy reports ---------------------------------------------------------------------------

export interface Report {
  feedback_id: number; at: string; body: string | null; conversation_id: number | null; message_id: number | null;
  reporter_uid: number; reporter_name: string | null; status: 'open' | 'resolved' | 'dismissed'; status_note: string | null;
  status_at: string | null; status_by: number | null; status_by_agent: boolean;
}

export async function listReports(status?: string, limit = 100): Promise<Report[]> {
  const r = await query(
    `SELECT f.id, f.created_at, f.body, f.conversation_id, f.message_id, f.user_id,
            (SELECT ${NAME_SQL} FROM waterfind_user u WHERE u.id = f.user_id) AS reporter_name,
            COALESCE(s.status, 'open') AS status, s.note, s.at AS status_at, s.actor_user_id, s.by_agent
       FROM feedback f LEFT JOIN kb_report_status s ON s.feedback_id = f.id
      WHERE f.kind = 'inaccuracy' ${status ? `AND COALESCE(s.status,'open') = $2` : ''}
      ORDER BY f.created_at DESC LIMIT $1`, status ? [limit, status] : [limit]);
  return (r.rows as any[]).map((x) => ({
    feedback_id: Number(x.id), at: x.created_at, body: x.body, conversation_id: x.conversation_id ? Number(x.conversation_id) : null,
    message_id: x.message_id ? Number(x.message_id) : null, reporter_uid: Number(x.user_id), reporter_name: x.reporter_name ?? null,
    status: x.status, status_note: x.note ?? null, status_at: x.status_at ?? null,
    status_by: x.actor_user_id ? Number(x.actor_user_id) : null, status_by_agent: !!x.by_agent,
  }));
}

export async function setReportStatus(feedbackId: number, status: 'open' | 'resolved' | 'dismissed', note: string | null, actor: TrainerIdentity, byAgent: boolean): Promise<void> {
  const exists = await query(`SELECT 1 FROM feedback WHERE id = $1 AND kind = 'inaccuracy'`, [feedbackId]);
  if (!exists.rowCount) throw new TrainerError(`no report #${feedbackId}`, 404);
  await query(
    `INSERT INTO kb_report_status (feedback_id, status, note, actor_user_id, by_agent, at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (feedback_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note,
       actor_user_id = EXCLUDED.actor_user_id, by_agent = EXCLUDED.by_agent, at = now()`,
    [feedbackId, status, note ? note.slice(0, 2000) : null, actor.userId, byAgent]);
}
