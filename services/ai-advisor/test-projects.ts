// Projects — DB-layer test: CRUD, the IDOR ownership chokepoint, conversation assignment,
// delete-keeps-chats, and the per-turn prompt-context lookup.
//
// Requires: local Postgres up (waterfind-db) with the ai_advisor schema migrated
// (npm run db:init), same as the other test-*.ts.
//   npx tsx test-projects.ts
//
// Uses synthetic user ids (ai_advisor.* has no FK to waterfind_user) and removes every row it
// creates in a finally, so the DB is left exactly as found.

import {
  createProject, listProjects, getOwnedProject, updateProject, deleteProject,
  assignConversationProject, projectForConversation,
} from './src/projects';
import { createConversation, getOwnedConversation, deleteConversation, NotFound } from './src/conversations';
import { query, pool } from './src/db';

const UID_A = 999999901;
const UID_B = 999999902;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
async function expectNotFound(name: string, p: Promise<unknown>) {
  try { await p; ok(name, false, 'resolved instead of throwing'); }
  catch (e) { ok(name, e instanceof NotFound, (e as Error).name); }
}

try {
  // 1. create + list
  const p1 = await createProject(UID_A, 'Smith family trust', 'Three licences in the Murrumbidgee.');
  const p2 = await createProject(UID_A, 'Goulburn spot trades', null);
  const listA = await listProjects(UID_A);
  ok('created projects appear in own list', listA.some((p) => p.id === p1.id) && listA.some((p) => p.id === p2.id));
  ok("other user's list stays empty", !(await listProjects(UID_B)).some((p) => p.id === p1.id || p.id === p2.id));

  // 2. IDOR chokepoint: every :id path refuses another user's project
  await expectNotFound('getOwnedProject rejects other user', getOwnedProject(p1.id, UID_B));
  await expectNotFound('updateProject rejects other user', updateProject(p1.id, UID_B, { name: 'stolen' }));
  await expectNotFound('deleteProject rejects other user', deleteProject(p1.id, UID_B));
  ok('project untouched after rejected update', (await getOwnedProject(p1.id, UID_A)).name === 'Smith family trust');

  // 3. update
  const p1b = await updateProject(p1.id, UID_A, { name: 'Smith trust (2026)', instructions: 'Report per-licence.' });
  ok('update changes name + instructions', p1b.name === 'Smith trust (2026)' && p1b.instructions === 'Report per-licence.');
  const p1c = await updateProject(p1.id, UID_A, { instructions: null });
  ok('instructions can be cleared, name kept', p1c.instructions === null && p1c.name === 'Smith trust (2026)');

  // 4. conversations created directly in a project
  const c1 = await createConversation(UID_A, 'Chat in project', p1.id);
  ok('createConversation records project_id', c1.project_id === p1.id);

  // 5. assignment: move out, move in, cross-user attempts refused
  await assignConversationProject(c1.id, UID_A, null);
  ok('move out -> ungrouped', (await getOwnedConversation(c1.id, UID_A)).project_id === null);
  await assignConversationProject(c1.id, UID_A, p2.id);
  ok('move into another project', (await getOwnedConversation(c1.id, UID_A)).project_id === p2.id);
  const pB = await createProject(UID_B, 'B project', null);
  await expectNotFound("cannot move own chat into another user's project", assignConversationProject(c1.id, UID_A, pB.id));
  await expectNotFound("cannot move another user's chat", assignConversationProject(c1.id, UID_B, pB.id));
  ok('assignment unchanged after refusals', (await getOwnedConversation(c1.id, UID_A)).project_id === p2.id);

  // 6. per-turn prompt context
  await updateProject(p2.id, UID_A, { instructions: 'Goulburn only.' });
  const ctx = await projectForConversation(c1.id, UID_A);
  ok('projectForConversation returns the project', ctx?.id === p2.id && ctx?.instructions === 'Goulburn only.');
  await assignConversationProject(c1.id, UID_A, null);
  ok('...and null when ungrouped', (await projectForConversation(c1.id, UID_A)) === null);

  // 7. deleting a project keeps its chats
  await assignConversationProject(c1.id, UID_A, p2.id);
  await deleteProject(p2.id, UID_A);
  const orphan = await getOwnedConversation(c1.id, UID_A);
  ok('chat survives project delete, ungrouped', orphan.project_id === null);
  await expectNotFound('deleted project is gone', getOwnedProject(p2.id, UID_A));

  await deleteConversation(c1.id, UID_A);
  await deleteProject(p1.id, UID_A);
  await deleteProject(pB.id, UID_B);
} finally {
  // belt-and-braces: remove anything a mid-test failure left behind
  await query('DELETE FROM conversation WHERE user_id IN ($1, $2)', [UID_A, UID_B]);
  await query('DELETE FROM project WHERE user_id IN ($1, $2)', [UID_A, UID_B]);
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
