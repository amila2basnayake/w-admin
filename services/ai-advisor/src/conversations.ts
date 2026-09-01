import { query } from './db';

export class NotFound extends Error {
  constructor(msg = 'not found') { super(msg); this.name = 'NotFound'; }
}

export interface Conversation {
  id: number;
  user_id: number;
  title: string;
  sdk_session_id: string | null;
  project_id: number | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  /** NULL for a client's own chat; the client's uid for a broker-assist chat (see db/assist.sql). */
  assist_client_uid: number | null;
  assist_staff_name: string | null;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parent_id: number | null;
  active: boolean;
  meta: any;
  created_at: string;
}

export async function listConversations(userId: number, includeArchived = false): Promise<Conversation[]> {
  const r = await query<Conversation>(
    `SELECT * FROM conversation
      WHERE user_id = $1 AND assist_client_uid IS NULL ${includeArchived ? '' : 'AND archived = false'}
      ORDER BY updated_at DESC`,
    [userId],
  );
  return r.rows;
}

export async function createConversation(userId: number, title = 'New chat', projectId: number | null = null): Promise<Conversation> {
  const r = await query<Conversation>(
    `INSERT INTO conversation (user_id, title, project_id) VALUES ($1, $2, $3) RETURNING *`,
    [userId, title, projectId],
  );
  return r.rows[0];
}

/**
 * THE ownership chokepoint for the CLIENT-facing surface. Every client-route operation that takes
 * a conversation :id MUST go through this, so a sequential bigserial id can never be used to reach
 * another user's data (IDOR). Assist conversations are excluded even for their creator: a staff
 * member's personal advisor chat and their working chats about clients are separate surfaces.
 */
export async function getOwnedConversation(id: number, userId: number): Promise<Conversation> {
  const r = await query<Conversation>(
    `SELECT * FROM conversation WHERE id = $1 AND user_id = $2 AND assist_client_uid IS NULL`,
    [id, userId],
  );
  if (r.rowCount === 0) throw new NotFound('conversation not found');
  return r.rows[0];
}

// ---- broker-assist surface (staff chatting ABOUT a client; see db/assist.sql) ----------------

/**
 * Assist chokepoint: the conversation must belong to THIS client's assist file. The caller's
 * staff status and the client binding both come from the verified token (assist/routes.ts), so
 * scoping by (id, assist_client_uid) shares one client's assist history across the broking team
 * — like notes on the client's CRM file — while conversations about any other client stay
 * unreachable however the :id is guessed.
 */
export async function getAssistConversation(id: number, clientUid: number): Promise<Conversation> {
  const r = await query<Conversation>(
    `SELECT * FROM conversation WHERE id = $1 AND assist_client_uid = $2`,
    [id, clientUid],
  );
  if (r.rowCount === 0) throw new NotFound('conversation not found');
  return r.rows[0];
}

export async function listAssistConversations(clientUid: number): Promise<Conversation[]> {
  const r = await query<Conversation>(
    `SELECT * FROM conversation
      WHERE assist_client_uid = $1 AND archived = false
      ORDER BY updated_at DESC`,
    [clientUid],
  );
  return r.rows;
}

export async function createAssistConversation(
  staffUid: number, staffName: string, clientUid: number, title = 'New chat',
): Promise<Conversation> {
  const r = await query<Conversation>(
    `INSERT INTO conversation (user_id, title, assist_client_uid, assist_staff_name)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [staffUid, title.slice(0, 200), clientUid, staffName.slice(0, 120) || null],
  );
  return r.rows[0];
}

/**
 * The CLIENT's own advisor chats (assist_client_uid IS NULL), for staff review from the client
 * page. READ-ONLY by construction: no write helper takes this shape, so staff can browse what the
 * advisor told the client but can never post into, rename or delete the client's own thread.
 * Archived chats stay hidden — staff see what the client sees.
 */
export async function listClientOwnConversations(clientUid: number): Promise<Array<Conversation & { message_count: number }>> {
  const r = await query<Conversation & { message_count: number }>(
    `SELECT c.*, (SELECT count(*)::int FROM message m WHERE m.conversation_id = c.id AND m.active) AS message_count
       FROM conversation c
      WHERE c.user_id = $1 AND c.assist_client_uid IS NULL AND c.archived = false
      ORDER BY c.updated_at DESC`,
    [clientUid],
  );
  return r.rows;
}

/**
 * One client-own transcript, ownership-checked against the token-bound client uid. The access-log
 * insert lives INSIDE the accessor so no caller can read a transcript without leaving a log row.
 */
export async function listClientOwnMessages(convId: number, clientUid: number, staffUid: number): Promise<Message[]> {
  const r = await query<Conversation>(
    `SELECT id FROM conversation
      WHERE id = $1 AND user_id = $2 AND assist_client_uid IS NULL AND archived = false`,
    [convId, clientUid],
  );
  if (r.rowCount === 0) throw new NotFound('conversation not found');
  await query(
    `INSERT INTO assist_transcript_access (staff_user_id, client_uid, conversation_id)
     VALUES ($1, $2, $3)`,
    [staffUid, clientUid, convId],
  );
  return fetchMessages(convId);
}

export async function renameAssistConversation(id: number, clientUid: number, title: string): Promise<void> {
  await getAssistConversation(id, clientUid);
  await query(`UPDATE conversation SET title = $1, updated_at = now() WHERE id = $2`, [title.slice(0, 200), id]);
}

/** Delete is limited to the conversation's creator — shared visibility, per-author removal. */
export async function deleteAssistConversation(id: number, clientUid: number, staffUid: number): Promise<void> {
  const conv = await getAssistConversation(id, clientUid);
  if (conv.user_id !== staffUid) throw new NotFound('conversation not found'); // no existence oracle
  await query(`DELETE FROM conversation WHERE id = $1`, [id]); // messages cascade
}

export async function listAssistMessages(convId: number, clientUid: number): Promise<Message[]> {
  await getAssistConversation(convId, clientUid);
  return fetchMessages(convId);
}

/**
 * Titler-only rename: applies the generated name ONLY if the title is still the derived one it is
 * replacing, so a manual rename that raced the async titler always wins. Trusted server path — the
 * id came from pumpTurn, not from a request. updated_at is deliberately NOT bumped: an automatic
 * cosmetic rename must not reshuffle history ordering. Returns whether the rename applied.
 */
export async function retitleIfUnchanged(id: number, expected: string, title: string): Promise<boolean> {
  const r = await query(
    `UPDATE conversation SET title = $1 WHERE id = $2 AND title = $3`,
    [title.slice(0, 200), id, expected],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function renameConversation(id: number, userId: number, title: string): Promise<void> {
  await getOwnedConversation(id, userId);
  await query(`UPDATE conversation SET title = $1, updated_at = now() WHERE id = $2`, [title.slice(0, 200), id]);
}

export async function setArchived(id: number, userId: number, archived: boolean): Promise<void> {
  await getOwnedConversation(id, userId);
  await query(`UPDATE conversation SET archived = $1, updated_at = now() WHERE id = $2`, [archived, id]);
}

export async function deleteConversation(id: number, userId: number): Promise<void> {
  await getOwnedConversation(id, userId);
  await query(`DELETE FROM conversation WHERE id = $1`, [id]); // messages cascade
}

export async function setSessionId(id: number, sdkSessionId: string | null): Promise<void> {
  await query(`UPDATE conversation SET sdk_session_id = $1 WHERE id = $2`, [sdkSessionId, id]);
}

async function fetchMessages(convId: number, onlyActive = true): Promise<Message[]> {
  const r = await query<Message>(
    `SELECT * FROM message
      WHERE conversation_id = $1 ${onlyActive ? 'AND active = true' : ''}
      ORDER BY created_at, id`,
    [convId],
  );
  return r.rows;
}

export async function listMessages(convId: number, userId: number, onlyActive = true): Promise<Message[]> {
  await getOwnedConversation(convId, userId);
  return fetchMessages(convId, onlyActive);
}

export async function addMessage(
  convId: number,
  role: Message['role'],
  content: string,
  opts: { parentId?: number | null; meta?: any } = {},
): Promise<Message> {
  const r = await query<Message>(
    `INSERT INTO message (conversation_id, role, content, parent_id, meta)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [convId, role, content, opts.parentId ?? null, opts.meta ?? null],
  );
  await query(`UPDATE conversation SET updated_at = now() WHERE id = $1`, [convId]);
  return r.rows[0];
}

/**
 * Deactivate the given message and everything after it on the active branch.
 * Used by edit-and-resend / regenerate so the DB history reflects the new branch.
 */
export async function deactivateFrom(convId: number, userId: number, fromMessageId: number): Promise<void> {
  await getOwnedConversation(convId, userId);
  await query(
    `UPDATE message SET active = false
      WHERE conversation_id = $1 AND active = true
        AND (created_at, id) >= (SELECT created_at, id FROM message WHERE id = $2 AND conversation_id = $1)`,
    [convId, fromMessageId],
  );
}

export async function searchConversations(userId: number, q: string): Promise<Conversation[]> {
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
  const r = await query<Conversation>(
    `SELECT DISTINCT c.* FROM conversation c
       LEFT JOIN message m ON m.conversation_id = c.id AND m.active = true
      WHERE c.user_id = $1 AND c.assist_client_uid IS NULL AND (c.title ILIKE $2 OR m.content ILIKE $2)
      ORDER BY c.updated_at DESC`,
    [userId, like],
  );
  return r.rows;
}

export interface Settings { theme: string; custom_instructions: string | null; }

export async function getSettings(userId: number): Promise<Settings> {
  const r = await query<Settings>(
    `SELECT theme, custom_instructions FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  return r.rows[0] ?? { theme: 'light', custom_instructions: null };
}

export async function putSettings(userId: number, theme: string, customInstructions: string | null): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, theme, custom_instructions, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET theme = EXCLUDED.theme,
           custom_instructions = EXCLUDED.custom_instructions,
           updated_at = now()`,
    [userId, theme === 'dark' ? 'dark' : 'light', customInstructions],
  );
}
