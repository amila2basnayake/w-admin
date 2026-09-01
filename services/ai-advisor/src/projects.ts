import { query } from './db';
import { NotFound, getOwnedConversation } from './conversations';

export interface Project {
  id: number;
  user_id: number;
  name: string;
  instructions: string | null;
  created_at: string;
  updated_at: string;
}

export async function listProjects(userId: number): Promise<Project[]> {
  const r = await query<Project>(
    `SELECT * FROM project WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
  return r.rows;
}

const MAX_INSTRUCTIONS = 4000;

export async function createProject(userId: number, name: string, instructions: string | null): Promise<Project> {
  const r = await query<Project>(
    `INSERT INTO project (user_id, name, instructions) VALUES ($1, $2, $3) RETURNING *`,
    [userId, name.slice(0, 100), instructions?.slice(0, MAX_INSTRUCTIONS) ?? null],
  );
  return r.rows[0];
}

/**
 * THE ownership chokepoint for projects — same rule as getOwnedConversation: every operation
 * that takes a project :id MUST go through this so a sequential id can never reach another
 * user's project (IDOR).
 */
export async function getOwnedProject(id: number, userId: number): Promise<Project> {
  const r = await query<Project>(
    `SELECT * FROM project WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (r.rowCount === 0) throw new NotFound('project not found');
  return r.rows[0];
}

export async function updateProject(
  id: number,
  userId: number,
  patch: { name?: string; instructions?: string | null },
): Promise<Project> {
  // Single UPDATE, untouched fields left alone in SQL — a concurrent PATCH to the
  // other field can't be clobbered by a stale read (and ownership is in the WHERE).
  const r = await query<Project>(
    `UPDATE project
        SET name = COALESCE($1, name),
            instructions = CASE WHEN $2::boolean THEN $3::text ELSE instructions END,
            updated_at = now()
      WHERE id = $4 AND user_id = $5 RETURNING *`,
    [
      patch.name !== undefined ? patch.name.slice(0, 100) : null,
      patch.instructions !== undefined,
      patch.instructions !== undefined ? patch.instructions?.slice(0, MAX_INSTRUCTIONS) ?? null : null,
      id, userId,
    ],
  );
  if (r.rowCount === 0) throw new NotFound('project not found');
  return r.rows[0];
}

/** Deletes the project only — its conversations survive ungrouped (FK is ON DELETE SET NULL). */
export async function deleteProject(id: number, userId: number): Promise<void> {
  await getOwnedProject(id, userId);
  await query(`DELETE FROM project WHERE id = $1`, [id]);
}

/** Move a conversation into a project (or out with null). Both must belong to the caller. */
export async function assignConversationProject(convId: number, userId: number, projectId: number | null): Promise<void> {
  await getOwnedConversation(convId, userId);
  if (projectId != null) await getOwnedProject(projectId, userId);
  try {
    await query(`UPDATE conversation SET project_id = $1, updated_at = now() WHERE id = $2`, [projectId, convId]);
  } catch (e: any) {
    // FK violation: the project was deleted between the ownership check and the write — 404, not 500.
    if (e?.code === '23503') throw new NotFound('project not found');
    throw e;
  }
}

/** The project a conversation belongs to, or null. Ownership of the conversation is enforced. */
export async function projectForConversation(convId: number, userId: number): Promise<Project | null> {
  const conv = await getOwnedConversation(convId, userId);
  if (conv.project_id == null) return null;
  return getOwnedProject(conv.project_id, userId).catch((e) => {
    if (e instanceof NotFound) return null; // project deleted mid-flight
    throw e;
  });
}
