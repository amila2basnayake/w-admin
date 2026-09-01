import { query } from './db';
import { NotFound } from './conversations';

// User feedback (beta programme): "report inaccuracy" on a specific assistant reply, or general
// product feedback from the header button. Stored in ai_advisor.feedback, read via SQL for now.

export type FeedbackKind = 'inaccuracy' | 'general';

export async function insertFeedback(
  userId: number,
  args: { kind: FeedbackKind; body: string | null; conversationId: number | null; messageId: number | null },
): Promise<number> {
  // Ownership: a message/conversation id is only accepted if it belongs to the caller — feedback
  // must never become a probe for other tenants' ids.
  if (args.messageId != null) {
    const chk = await query(
      `SELECT m.conversation_id FROM message m
         JOIN conversation c ON c.id = m.conversation_id
        WHERE m.id = $1 AND c.user_id = $2`, [args.messageId, userId]);
    if (chk.rowCount === 0) throw new NotFound('message not found');
    args.conversationId = Number(chk.rows[0].conversation_id);
  } else if (args.conversationId != null) {
    const chk = await query(
      `SELECT 1 FROM conversation WHERE id = $1 AND user_id = $2`, [args.conversationId, userId]);
    if (chk.rowCount === 0) throw new NotFound('conversation not found');
  }
  const r = await query<{ id: number }>(
    `INSERT INTO feedback (user_id, conversation_id, message_id, kind, body)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, args.conversationId, args.messageId, args.kind,
     args.body ? args.body.slice(0, 4000) : null]);
  return r.rows[0].id;
}
