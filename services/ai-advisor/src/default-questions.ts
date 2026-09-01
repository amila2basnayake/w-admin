import { query } from './db';

/**
 * The default questions offered on an EMPTY new chat, per audience:
 *   'broker' — the Client Rail on the CRM client page (staff chatting about a client)
 *   'client' — the client's own AI Advisor tab
 * Stored one row per audience in ai_advisor.default_questions (db/default-questions.sql) and
 * edited in the AI Trainer's Questions tab. No row = the built-ins below — which the two chat
 * SPAs also carry as their render-instantly / fetch-failed fallback, so keep all three in step.
 */

export type QuestionAudience = 'broker' | 'client';
export const QUESTION_AUDIENCES: readonly QuestionAudience[] = ['broker', 'client'];

export const BUILT_IN_QUESTIONS: Record<QuestionAudience, readonly string[]> = {
  broker: [
    'Verify accurate account setup',
    'Summarise this client’s position and anything that needs attention',
    'What are their allocation holdings worth at current prices?',
    'Any carryover or deadline risk for them this season?',
  ],
  client: [
    "What's the difference between a water allocation and an entitlement?",
    'How do carryover rules work in the southern Murray–Darling Basin?',
    'A client wants to sell 500ML of high-security entitlement — what should I check?',
    'What typically drives allocation prices during a wet season?',
  ],
};

// Wire bounds, not editorial ones: a "question" is a clickable chip, and a list an admin scrolls.
export const QUESTION_MAX_CHARS = 500;
export const QUESTION_MAX_COUNT = 50;

/** Normalise an incoming list: strings only, whitespace collapsed, blanks dropped. Throws with a
 *  human-readable message on anything else (the trainer route turns that into a 400). */
export function cleanQuestionList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('questions must be a list of strings');
  if (v.length > QUESTION_MAX_COUNT) throw new Error(`at most ${QUESTION_MAX_COUNT} questions per list`);
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') throw new Error('questions must be a list of strings');
    const s = item.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (s.length > QUESTION_MAX_CHARS) throw new Error(`a question is ${s.length} characters; the limit is ${QUESTION_MAX_CHARS}`);
    out.push(s);
  }
  return out;
}

/** version 0 = no stored row, the built-ins are serving. */
export interface QuestionSet { questions: string[]; version: number; updated_by: number | null; updated_at: string | null }

export async function getQuestionSet(audience: QuestionAudience): Promise<QuestionSet> {
  const r = await query<{ questions: unknown; version: number; updated_by: number; updated_at: string }>(
    `SELECT questions, version, updated_by, updated_at FROM default_questions WHERE audience = $1`, [audience]);
  if (!r.rowCount) return { questions: [...BUILT_IN_QUESTIONS[audience]], version: 0, updated_by: null, updated_at: null };
  const row = r.rows[0];
  const qs = Array.isArray(row.questions) ? row.questions.filter((x): x is string => typeof x === 'string') : [];
  return { questions: qs, version: Number(row.version), updated_by: Number(row.updated_by), updated_at: row.updated_at };
}

/** Serving variant for the chat surfaces: the chips must never break a chat page, so any lookup
 *  failure (table missing, DB down) falls back to the built-ins. */
export async function questionsFor(audience: QuestionAudience): Promise<string[]> {
  try {
    return (await getQuestionSet(audience)).questions;
  } catch (e) {
    console.error(`default questions lookup failed (${audience}):`, e);
    return [...BUILT_IN_QUESTIONS[audience]];
  }
}

/**
 * Save one audience's list. `expectVersion` is the version the editor loaded (0 = it saw the
 * built-ins, no row yet). Returns false when someone else saved in between — the caller answers
 * 409 and the editor reloads. Race-free without a transaction: the version predicate and the
 * ON CONFLICT DO NOTHING each decide atomically.
 */
export async function saveQuestionSet(audience: QuestionAudience, questions: string[], actorUserId: number, expectVersion: number): Promise<boolean> {
  const json = JSON.stringify(questions);
  if (expectVersion === 0) {
    const r = await query(
      `INSERT INTO default_questions (audience, questions, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (audience) DO NOTHING`, [audience, json, actorUserId]);
    return r.rowCount === 1;
  }
  const r = await query(
    `UPDATE default_questions SET questions = $2::jsonb, version = version + 1, updated_by = $3, updated_at = now()
      WHERE audience = $1 AND version = $4`, [audience, json, actorUserId, expectVersion]);
  return r.rowCount === 1;
}
