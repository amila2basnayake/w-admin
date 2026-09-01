/**
 * AI Trainer — integration test of the knowledge store: real Postgres (kb_event / kb_checkpoint),
 * a SCRATCH copy of the knowledge tree (KNOWLEDGE_DIR), git commits off.
 *
 *   npx tsx itest-trainer.ts
 *
 * Exercises the full ledger contract end to end: create / update / patch / delete → undo, restore
 * to a point (event / checkpoint / time), restore a single version, batch undo, hash conflict.
 * Cleans up its own rows (actor uid 999999) and the scratch tree.
 */
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'wf-trainer-'));
const KDIR = join(scratch, 'knowledge');
mkdirSync(join(KDIR, 'regulatory', 'nsw'), { recursive: true });
mkdirSync(join(KDIR, 'notes'), { recursive: true });
mkdirSync(join(KDIR, 'library'), { recursive: true });
// Seed with a real regulatory doc so update/patch have something to bite on.
const src = join(process.cwd(), 'knowledge', 'regulatory', 'nsw');
const seedName = readdirSync(src).find((f: string) => f.endsWith('.md'))!;
cpSync(join(src, seedName), join(KDIR, 'regulatory', 'nsw', seedName));
process.env.KNOWLEDGE_DIR = KDIR;
process.env.TRAINER_GIT_COMMIT = '0';
process.env.TRAINER_MAINTENANCE = '0';   // no startup reconcile against the scratch tree

const ACTOR = { userId: 999999, name: 'itest' };
let pass = 0, fail = 0;
function ok(cond: unknown, msg: string) { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } }
const read = (rel: string) => existsSync(join(scratch, rel)) ? readFileSync(join(scratch, rel), 'utf8') : null;

async function main() {
  const store = await import('./src/trainer/store');
  const { loadCorpus } = await import('./src/knowledge-tools');
  const { loadNotes, noteFileFor } = await import('./src/notes');
  const { query, pool } = await import('./src/db');

  const seedId = loadCorpus(true)[0].id;
  console.log(`scratch ${scratch}; seed doc ${seedId}`);
  const startMax = Number((await query(`SELECT COALESCE(max(id),0) AS m FROM kb_event`)).rows[0].m);

  // --- create ---------------------------------------------------------------------------------
  const libDoc = (v: string) => `---\nid: itest-proc\ntitle: Itest Procedure ${v}\nas_at: 2026-08-18\nsummary: itest summary\n---\n\nBody version ${v} of the itest procedure.\n`;
  const e1 = await store.createArtifact({ kind: 'doc', id: 'itest-proc', content: libDoc('1'), actor: ACTOR, via: 'manual', summary: 'create', collection: 'library' });
  ok(e1.op === 'create' && e1.before_content === null && read('knowledge/library/itest-proc.md') === libDoc('1'), 'create writes the file and a create event');
  ok(loadCorpus(true).some((d) => d.id === 'itest-proc' && d.collection === 'library'), 'advisor loader sees the new library doc');
  let threw = false; try { await store.createArtifact({ kind: 'doc', id: 'itest-proc', content: libDoc('1'), actor: ACTOR, via: 'manual', summary: 'dup', collection: 'library' }); } catch { threw = true; }
  ok(threw, 'duplicate id refused');

  // --- update + hash conflict ------------------------------------------------------------------
  const e2 = await store.updateArtifact({ kind: 'doc', id: 'itest-proc', content: libDoc('2'), actor: ACTOR, via: 'chat', summary: 'v2', expectedHash: store.sha256(libDoc('1')) });
  ok(e2.op === 'update' && e2.before_content === libDoc('1') && e2.after_content === libDoc('2'), 'update records before/after');
  threw = false; try { await store.updateArtifact({ kind: 'doc', id: 'itest-proc', content: libDoc('3'), actor: ACTOR, via: 'manual', summary: 'stale', expectedHash: store.sha256(libDoc('1')) }); } catch (e: any) { threw = e.status === 409; }
  ok(threw, 'stale expected_hash → 409');
  threw = false; try { await store.updateArtifact({ kind: 'doc', id: 'itest-proc', content: libDoc('2'), actor: ACTOR, via: 'manual', summary: 'same' }); } catch (e: any) { threw = e.status === 409; }
  ok(threw, 'identical content → nothing to change');

  // --- patch --------------------------------------------------------------------------------
  const e3 = await store.patchArtifact({ kind: 'doc', id: 'itest-proc', find: 'Body version 2', replace: 'Body version 2 (patched)', actor: ACTOR, via: 'chat', summary: 'patch' });
  ok(read('knowledge/library/itest-proc.md')!.includes('(patched)') && e3.op === 'update', 'patch applies an exact-match edit');
  threw = false; try { await store.patchArtifact({ kind: 'doc', id: 'itest-proc', find: 'nope', replace: 'x', actor: ACTOR, via: 'chat', summary: 'p' }); } catch { threw = true; }
  ok(threw, 'patch with no match refused');

  // --- regulatory patch on the seeded doc ----------------------------------------------------
  const seedRaw = read(`knowledge/regulatory/nsw/${seedName}`)!;
  const e4 = await store.patchArtifact({ kind: 'doc', id: seedId, find: seedRaw.slice(seedRaw.indexOf('\n---\n') + 5, seedRaw.indexOf('\n---\n') + 25), replace: 'ITEST-MARK ', actor: ACTOR, via: 'chat', summary: 'mark seed' });
  ok(read(`knowledge/regulatory/nsw/${seedName}`)!.includes('ITEST-MARK') && e4.path === `knowledge/regulatory/nsw/${seedName}`, 'regulatory doc patched in place, path derived from the corpus');

  // --- notes --------------------------------------------------------------------------------
  const n1 = await store.createArtifact({ kind: 'note', id: 'itest-note', content: noteFileFor({ id: 'itest-note', title: 'Itest', mode: 'retrieve', text: 'A note.' }), actor: ACTOR, via: 'manual', summary: 'note' });
  ok(n1.kind === 'note' && loadNotes(true).some((n) => n.id === 'itest-note'), 'note created and loadable');

  // --- checkpoint ---------------------------------------------------------------------------
  const cp = await store.createCheckpoint('itest checkpoint', ACTOR);
  ok(cp.last_event_id === Number(n1.id), 'checkpoint captures the high-water event id');

  // --- delete + undo ------------------------------------------------------------------------
  const e5 = await store.deleteArtifact({ kind: 'doc', id: 'itest-proc', actor: ACTOR, via: 'manual', summary: 'delete' });
  ok(e5.op === 'delete' && read('knowledge/library/itest-proc.md') === null && !loadCorpus(true).some((d) => d.id === 'itest-proc'), 'delete removes the file; loader no longer sees it');
  const u1 = await store.undoEvent(Number(e5.id), ACTOR);
  ok(u1.event && u1.event.op === 'create' && u1.event.undoes_event_id === Number(e5.id) && read('knowledge/library/itest-proc.md')!.includes('(patched)'), 'undo of a delete brings the last version back');
  const u1b = await store.undoEvent(Number(e5.id), ACTOR);
  ok(u1b.alreadyThere && !u1b.event, 'undoing an already-undone change is a no-op');
  const u2 = await store.undoEvent(Number(e2.id), ACTOR);
  ok(u2.event && read('knowledge/library/itest-proc.md') === libDoc('1') && u2.discards.length >= 2, 'undo of an older edit puts its before-text back and reports the discarded later changes');

  // --- restore a version ----------------------------------------------------------------------
  const rv = await store.restoreVersion(Number(e3.id), ACTOR);
  ok(rv.op === 'update' && read('knowledge/library/itest-proc.md')!.includes('(patched)'), 'restoreVersion writes that event\'s after-text');

  // --- restore to checkpoint (preview + apply) -----------------------------------------------
  const plan = await store.planRestore({ checkpointId: cp.id });
  ok(plan.changes.length === 0, 'state already matches the checkpoint (delete undone, version restored) → empty plan');
  await store.deleteArtifact({ kind: 'note', id: 'itest-note', actor: ACTOR, via: 'manual', summary: 'del note' });
  await store.updateArtifact({ kind: 'doc', id: 'itest-proc', content: libDoc('9'), actor: ACTOR, via: 'manual', summary: 'v9' });
  const plan2 = await store.planRestore({ checkpointId: cp.id });
  ok(plan2.changes.length === 2 && plan2.changes.some((c) => c.doc_id === 'itest-note' && c.action === 'create') && plan2.changes.some((c) => c.doc_id === 'itest-proc' && c.action === 'update'), 'plan lists the note to bring back and the doc to roll back');
  const r = await store.restoreTo({ checkpointId: cp.id }, ACTOR);
  ok(r.events.length === 2 && r.batchId && r.events.every((e) => e.batch_id === r.batchId && e.via === 'restore'), 'restore writes one batch');
  ok(read('knowledge/notes/itest-note.md') !== null && read('knowledge/library/itest-proc.md')!.includes('(patched)'), 'files match the checkpoint state');

  // --- batch undo -----------------------------------------------------------------------------
  const ub = await store.undoBatch(r.batchId!, ACTOR);
  ok(ub.length === 2 && read('knowledge/notes/itest-note.md') === null && read('knowledge/library/itest-proc.md') === libDoc('9'), 'undoing the batch reverses the restore');

  // --- restore to "before everything" ----------------------------------------------------------
  const plan0 = await store.planRestore({ eventId: startMax });
  ok(plan0.changes.length === 2 && plan0.changes.every((c) => (c.doc_id === 'itest-proc' && c.action === 'delete') || (c.doc_id === seedId && c.action === 'update')), 'restore-to-start would remove the created doc and unpatch the seed');
  const r0 = await store.restoreTo({ eventId: startMax }, ACTOR);
  ok(r0.events.length === 2 && read('knowledge/library/itest-proc.md') === null && read(`knowledge/regulatory/nsw/${seedName}`) === seedRaw, 'restore-to-start puts the tree back exactly');

  // --- restore by time -----------------------------------------------------------------------
  const atPlan = await store.planRestore({ at: new Date(Date.now() + 60_000).toISOString() });
  ok(atPlan.changes.length === 0, 'restore to "now" changes nothing');

  // --- history reads --------------------------------------------------------------------------
  const evs = await store.listEvents({ docId: 'itest-proc', limit: 100 });
  ok(evs.length >= 6 && evs[0].id > evs[evs.length - 1].id, 'listEvents by doc_id, newest first');
  const full = await store.getEventFull(Number(e2.id));
  ok(full.before_content === libDoc('1') && full.after_content === libDoc('2'), 'getEventFull returns both texts');

  // --- restore bound to its preview (ledger moved → 409) ----------------------------------------
  const cp2 = await store.createCheckpoint('itest cp2', ACTOR);
  const gDoc = (v: string) => `---\nid: itest-guard\ntitle: Guard ${v}\nas_at: 2026-08-18\nsummary: s\n---\n\nGuard body version ${v} of the document.\n`;
  await store.createArtifact({ kind: 'doc', id: 'itest-guard', content: gDoc('1'), actor: ACTOR, via: 'manual', summary: 'g1', collection: 'library' });
  const gPlan = await store.planRestore({ checkpointId: cp2.id });
  ok(gPlan.changes.length === 1 && gPlan.head > 0, 'preview: restoring to cp2 would remove the doc created after it; plan carries the ledger head');
  await store.updateArtifact({ kind: 'doc', id: 'itest-guard', content: gDoc('2'), actor: ACTOR, via: 'manual', summary: 'g2' });   // the ledger moves
  threw = false; try { await store.restoreTo({ checkpointId: cp2.id }, ACTOR, { expectHead: gPlan.head, expectChanges: 1 }); } catch (e: any) { threw = e.status === 409; }
  ok(threw, 'restore with a stale preview (head moved) → 409, nothing written');
  ok(read('knowledge/library/itest-guard.md') === gDoc('2'), 'the refused restore left the file alone');
  const gPlan2 = await store.planRestore({ checkpointId: cp2.id });
  const gRes = await store.restoreTo({ checkpointId: cp2.id }, ACTOR, { expectHead: gPlan2.head, expectChanges: gPlan2.changes.length });
  ok(gRes.events.length === 1 && read('knowledge/library/itest-guard.md') === null, 'restore with the fresh preview applies');
  // the chat restore card end to end: restore_to tool → SSE payload (wire point) → POST /restore parsing → restoreTo
  const { buildTrainerToolDefs } = await import('./src/trainer/tools');
  const toolCtx: any = { ...ACTOR, role: 'AI_TRAINER', sessionUploadIds: [], changes: [], restoreRequests: [] };
  const restoreTool: any = buildTrainerToolDefs(toolCtx).find((d: any) => d.name === 'restore_to');
  await store.createArtifact({ kind: 'doc', id: 'itest-guard', content: gDoc('3'), actor: ACTOR, via: 'manual', summary: 'g3', collection: 'library' });
  const toolOut = JSON.parse((await restoreTool.handler({ checkpoint_id: cp2.id }, {})).content[0].text);
  const card = toolCtx.restoreRequests[0];
  ok(toolOut.awaiting_click && card && card.point.checkpoint_id === cp2.id && typeof card.head === 'number' && card.changes.length === 1, 'restore_to emits a card with a snake_case wire point + head');
  const wirePosted = JSON.parse(JSON.stringify({ ...card.point, expect_head: card.head, expect_changes: card.changes.length }));   // what the SPA POSTs
  const viaCard = await store.restoreTo(store.pointFromWire(wirePosted), ACTOR, { expectHead: wirePosted.expect_head, expectChanges: wirePosted.expect_changes });
  ok(viaCard.events.length === 1 && read('knowledge/library/itest-guard.md') === null, 'the card payload round-trips through pointFromWire and restores');

  // --- uploads: "in the library" is derived from the corpus ------------------------------------
  const ingest = await import('./src/trainer/ingest');
  const up = await ingest.storeUpload(Buffer.from('The itest procedure text, long enough to count as real content for the library.'), 'itest-upload.txt', 'text/plain', ACTOR);
  ok(!up.duplicate && up.upload.text_status === 'ok' && existsSync(join(KDIR, 'uploads', up.upload.sha256, 'itest-upload.txt')), 'upload stored under the scratch knowledge dir, text extracted');
  const ann = { title: 'Itest Upload', summary: 'itest', document_type: 'internal procedure', jurisdiction: '', tags: ['itest'], key_points: ['one point'], source_urls: [], document_date: '' };
  const ingDoc = ingest.libraryDocFor(up.upload, ann, 'itest-upload', up.upload.text);
  const ingEv = await store.createArtifact({ kind: 'doc', id: 'itest-upload', content: ingDoc, actor: ACTOR, via: 'ingest', summary: 'ingest', collection: 'library', sourceUploadId: up.upload.id });
  await ingest.linkUploadToDoc(up.upload.id, 'itest-upload');
  const listed = () => ingest.listUploads().then((l) => l.find((u) => u.id === up.upload.id)!);
  ok((await listed()).doc_id === 'itest-upload' && (await listed()).file_present === true, 'after ingest the upload lists as in the library (doc_id) with its file present');
  const delEv = await store.deleteArtifact({ kind: 'doc', id: 'itest-upload', actor: ACTOR, via: 'manual', summary: 'del' });
  ok((await listed()).doc_id === null, 'after the document is deleted the upload is re-ingestable (doc_id null)');
  await store.undoEvent(Number(delEv.id), ACTOR);
  ok((await listed()).doc_id === 'itest-upload', 'undo brings the document back and the upload shows as in the library again');
  unlinkSync(join(KDIR, 'uploads', up.upload.sha256, 'itest-upload.txt'));
  threw = false; try { ingest.readUploadBytes(up.upload); } catch (e: any) { threw = e.status === 404 && /not on this host/.test(e.message); }
  ok(threw && (await listed()).file_present === false, 'original file gone from this host → 404 with a plain reason; listing says file_present false');
  void ingEv;

  // --- conversation search is access-logged ----------------------------------------------------
  const lookup = await import('./src/trainer/lookup');
  const before = Number((await query(`SELECT count(*)::int AS n FROM kb_access_log WHERE reader_user_id = $1`, [ACTOR.userId])).rows[0].n);
  const hits = await lookup.findConversations({ text: 'water', limit: 5 }, { reader: ACTOR, byAgent: true });
  const after = Number((await query(`SELECT count(*)::int AS n FROM kb_access_log WHERE reader_user_id = $1`, [ACTOR.userId])).rows[0].n);
  ok(after - before === hits.length, `a search that returned ${hits.length} conversation(s) wrote ${after - before} access-log row(s) (one per conversation shown)`);
  if (hits.length) {
    const row = (await query(`SELECT purpose, by_agent, conversation_id FROM kb_access_log WHERE reader_user_id = $1 ORDER BY id DESC LIMIT 1`, [ACTOR.userId])).rows[0];
    ok(/^search text="water"/.test(row.purpose) && row.by_agent === true && hits.some((h) => h.id === Number(row.conversation_id)), 'the log row carries the search terms, by_agent and the conversation id');
  }
  const unlogged = await lookup.findConversations({ text: 'water', limit: 5 });
  ok(Number((await query(`SELECT count(*)::int AS n FROM kb_access_log WHERE reader_user_id = $1`, [ACTOR.userId])).rows[0].n) === after && unlogged.length === hits.length, 'an internal lookup without a reader does not log (readConversation logs on its own)');

  // --- reconcile: changes made outside the Trainer -----------------------------------------------
  const only = (rel: string) => /^knowledge\/(library|notes)\/itest-x-/.test(rel);
  const xDoc = (v: string) => `---\nid: itest-x-doc\ntitle: X ${v}\nas_at: 2026-08-18\nsummary: s\n---\n\nExternal body ${v} of the document.\n`;
  await store.createArtifact({ kind: 'doc', id: 'itest-x-doc', content: xDoc('1'), actor: ACTOR, via: 'manual', summary: 'x1', collection: 'library' });
  await store.createArtifact({ kind: 'doc', id: 'itest-x-gone', content: xDoc('1').replace(/itest-x-doc/, 'itest-x-gone'), actor: ACTOR, via: 'manual', summary: 'xg', collection: 'library' });
  const r0a = await store.reconcileExternal({ actorUserId: ACTOR.userId, filter: only, unledgered: 'create' });
  ok(r0a.events.length === 0 && r0a.files === 2, 'in step with the ledger → reconcile records nothing');
  writeFileSync(join(KDIR, 'library', 'itest-x-doc.md'), xDoc('2'), 'utf8');                       // edited on disk (a deploy)
  writeFileSync(join(KDIR, 'library', 'itest-x-new.md'), xDoc('9').replace(/itest-x-doc/, 'itest-x-new'), 'utf8');   // appeared on disk
  unlinkSync(join(KDIR, 'library', 'itest-x-gone.md'));                                             // removed on disk
  const r1 = await store.reconcileExternal({ actorUserId: ACTOR.userId, filter: only, unledgered: 'create' });
  const byId = Object.fromEntries(r1.events.map((e) => [e.doc_id, e]));
  ok(r1.events.length === 3 && r1.batchId && r1.events.every((e) => e.via === 'external' && e.batch_id === r1.batchId), 'reconcile wrote 3 external events as one batch');
  ok(byId['itest-x-doc']?.op === 'update' && byId['itest-x-doc'].before_content === xDoc('1') && byId['itest-x-doc'].after_content === xDoc('2'), 'edited on disk → external update with the ledgered before + the disk after');
  ok(byId['itest-x-new']?.op === 'create' && byId['itest-x-new'].before_content === null, 'appeared on disk (later run) → external create');
  ok(byId['itest-x-gone']?.op === 'delete' && byId['itest-x-gone'].after_content === null && byId['itest-x-gone'].before_content?.includes('itest-x-gone'), 'removed on disk → external delete carrying the last ledgered text');
  const r2 = await store.reconcileExternal({ actorUserId: ACTOR.userId, filter: only, unledgered: 'create' });
  ok(r2.events.length === 0, 'a second reconcile finds nothing (idempotent)');
  const ux = await store.undoEvent(Number(byId['itest-x-gone'].id), ACTOR);
  ok(ux.event && read('knowledge/library/itest-x-gone.md')?.includes('itest-x-gone'), 'undo of an external delete brings the file back');
  const xPlan = await store.planRestore({ eventId: Number(byId['itest-x-doc'].id) - 1 });
  ok(xPlan.changes.some((c) => c.doc_id === 'itest-x-doc' && c.action === 'update') && xPlan.changes.some((c) => c.doc_id === 'itest-x-new' && c.action === 'delete'), 'restore-to-point now sees the external edit and the external arrival');
  writeFileSync(join(KDIR, 'notes', 'itest-x-base.md'), noteFileFor({ id: 'itest-x-base', title: 'Base', mode: 'retrieve', text: 'Predates the ledger.' }), 'utf8');
  const r3 = await store.reconcileExternal({ actorUserId: ACTOR.userId, filter: only, unledgered: 'snapshot' });
  const snap = r3.events.find((e) => e.doc_id === 'itest-x-base');
  ok(r3.events.length === 1 && snap?.op === 'snapshot' && snap.kind === 'note' && snap.before_content === snap.after_content, 'first-run mode: an unledgered file gets a baseline snapshot (before == after)');
  const snapPlan = await store.planRestore({ eventId: Number(snap!.id) - 1 });
  ok(!snapPlan.changes.some((c) => c.doc_id === 'itest-x-base'), 'restore to before a snapshot leaves the baseline file alone (a floor, not a creation)');
  const usnap = await store.undoEvent(Number(snap!.id), ACTOR);
  ok(usnap.alreadyThere, 'undo of a snapshot is a no-op');
  const extCount = await store.externalChangeCount();
  ok(extCount >= 3, `externalChangeCount counts external non-snapshot events (${extCount})`);
  const refusal = await store.gitCommitRefusal();
  ok(refusal === null || typeof refusal === 'string', `gitCommitRefusal answers without throwing (${refusal ?? 'may commit on this checkout'})`);

  // --- cleanup --------------------------------------------------------------------------------
  await query(`DELETE FROM kb_event WHERE actor_user_id = $1`, [ACTOR.userId]);
  await query(`DELETE FROM kb_checkpoint WHERE created_by = $1`, [ACTOR.userId]);
  await query(`DELETE FROM kb_upload WHERE uploaded_by = $1`, [ACTOR.userId]);
  await query(`DELETE FROM kb_access_log WHERE reader_user_id = $1`, [ACTOR.userId]);
  await pool.end();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); rmSync(scratch, { recursive: true, force: true }); process.exit(1); });
