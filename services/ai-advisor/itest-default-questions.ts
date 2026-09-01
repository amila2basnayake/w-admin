/**
 * Default questions — integration test against the real Postgres table
 * (ai_advisor.default_questions; apply db/default-questions.sql first).
 *
 *   npx tsx itest-default-questions.ts
 *
 * Exercises: built-ins when no row, save/read round-trip, version bump, the stale-version guard
 * (both the no-row INSERT race and the UPDATE race), and the serving fallback. Any rows that exist
 * before the run are put back exactly as they were.
 */
import { pool, query } from './src/db';
import {
  getQuestionSet, saveQuestionSet, questionsFor, BUILT_IN_QUESTIONS,
  QUESTION_AUDIENCES, type QuestionAudience,
} from './src/default-questions';

let pass = 0, fail = 0;
function ok(cond: unknown, msg: string) { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } }

const ACTOR = 999999;

async function main() {
  // Preserve whatever is really stored, restore on the way out.
  const before = await query(`SELECT audience, questions, version, updated_by, updated_at FROM default_questions`);
  try {
    await query(`DELETE FROM default_questions`);

    // --- no row → built-ins, version 0 ---------------------------------------------------------
    for (const a of QUESTION_AUDIENCES) {
      const s = await getQuestionSet(a);
      ok(s.version === 0 && s.updated_by === null && JSON.stringify(s.questions) === JSON.stringify(BUILT_IN_QUESTIONS[a]), `${a}: no row → built-ins, version 0`);
      ok(JSON.stringify(await questionsFor(a)) === JSON.stringify(BUILT_IN_QUESTIONS[a]), `${a}: serving list matches`);
    }

    // --- first save (expect 0 = INSERT) --------------------------------------------------------
    const brokerList = ['What changed for this client this week?', 'Draft a market update for them'];
    ok(await saveQuestionSet('broker', brokerList, ACTOR, 0) === true, 'broker: first save (version 0) lands');
    let s = await getQuestionSet('broker');
    ok(s.version === 1 && s.updated_by === ACTOR && JSON.stringify(s.questions) === JSON.stringify(brokerList), 'broker: round-trip, version 1, actor stamped');
    ok(JSON.stringify(await questionsFor('broker')) === JSON.stringify(brokerList), 'broker: serving list is the stored one');
    ok(JSON.stringify(await questionsFor('client')) === JSON.stringify(BUILT_IN_QUESTIONS.client), 'client: still built-ins — the lists are independent');

    // --- stale expects refused -----------------------------------------------------------------
    ok(await saveQuestionSet('broker', ['late'], ACTOR, 0) === false, 'broker: a second version-0 save (row now exists) is refused');
    ok(await saveQuestionSet('broker', ['late'], ACTOR, 5) === false, 'broker: a stale version is refused');

    // --- update (expect current) ---------------------------------------------------------------
    ok(await saveQuestionSet('broker', [], ACTOR, 1) === true, 'broker: saving an empty list is allowed');
    s = await getQuestionSet('broker');
    ok(s.version === 2 && s.questions.length === 0, 'broker: empty list stored, version bumped');
    ok((await questionsFor('broker')).length === 0, 'broker: an empty stored list serves as no suggestions (not the built-ins)');
  } finally {
    await query(`DELETE FROM default_questions`);
    for (const r of before.rows as any[]) {
      await query(
        `INSERT INTO default_questions (audience, questions, version, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5)`,
        [r.audience, JSON.stringify(r.questions), r.version, r.updated_by, r.updated_at]);
    }
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
