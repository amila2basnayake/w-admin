/**
 * Call notes — live integration test. Spawns its OWN sidecar on :3101 (override with
 * CALLNOTES_ITEST_PORT) wired to an in-process fake PBX, seeds ended phone-record rows on the
 * test client's CRM account, and checks both halves of the feature:
 *   1. the pre-drafting worker picks the ended calls up unprompted -> PBX fetch -> OpenAI STT ->
 *      Claude draft -> a READY row (nothing written to the CRM);
 *   2. GET /assist/call-note/prefill (what the Add Comment popup calls) answers with the text for
 *      the broker's latest call — and, for a call the worker never saw, starts the draft on demand
 *      and reports `drafting` until it is ready.
 * Needs the OpenAI + Anthropic credentials the sidecar normally has and the TTS fixtures
 * (npm run callnotes:fixtures). ~$1 of model calls. The spawned sidecar inherits .env but has
 * voice / auto-refresh / retention / trainer-git switched OFF so it never starts other pollers or
 * schedulers against the shared DB.
 *
 *   npm run itest:call-notes
 */
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './src/config';
import { query, pool } from './src/db';
import { startFakePbx } from './test/fake-pbx';

const PORT = Number(process.env.CALLNOTES_ITEST_PORT) || 3101, BASE = `http://localhost:${PORT}`;
/** Child sidecar: nothing that polls, schedules or commits against the shared DB / repo — except
 *  the pre-drafting worker under test. */
const QUIET_ENV = { AIADVISOR_VOICE_ENABLED: '0', ADVISOR_AUTO_REFRESH: '0', AIADVISOR_CALL_NOTE_RETENTION_DAYS: '0', TRAINER_GIT_COMMIT: '0' };
const STAFF_UID = 10, CLIENT_UID = 2725534, CLIENT_NAME = 'Beth', OTHER_CLIENT_UID = 119063, OTHER_CLIENT_NAME = 'Stuart';
const FIX = join(process.cwd(), 'test', 'fixtures', 'calls');

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${n}${d ? '  (' + d + ')' : ''}`); c ? pass++ : fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function b64url(b: Buffer) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function mint(claims: Record<string, unknown>) {
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', config.sharedSecret).update(body).digest());
  return `${body}.${sig}`;
}
function assistToken(clientUid: number, clientName: string) {
  const now = Math.floor(Date.now() / 1000);
  return mint({ uid: STAFF_UID, name: 'Admin Test', ut: 3, iat: now, exp: now + 900, nonce: 'cn', act: clientUid, actName: clientName });
}
async function prefill(token: string): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + '/assist/call-note/prefill', { headers: { Authorization: 'Bearer ' + token } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function noteRow(phonecallId: string): Promise<any | null> {
  const r = await query(`SELECT * FROM call_note WHERE phonecall_id = $1`, [phonecallId]);
  return r.rows[0] ?? null;
}
/** Wait until the worker has taken the call to a terminal state. */
async function waitForDone(phonecallId: string, timeoutMs = 300_000): Promise<any | null> {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await noteRow(phonecallId);
    if (last && (last.status === 'failed' || last.status === 'ready')) return last;
    await sleep(2500);
  }
  return last;
}
/** Poll the prefill route the way the popup does, until it stops saying `drafting`. */
async function waitForPrefill(token: string, timeoutMs = 300_000): Promise<any> {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await prefill(token);
    if (!(last.status === 200 && last.body?.status === 'drafting')) return last;
    await sleep(2500);
  }
  return last;
}

async function main() {
  const fixturesPresent = existsSync(join(FIX, 'left-message.wav')) && existsSync(join(FIX, 'temp-sell-negotiation.stereo.wav'));
  if (!fixturesPresent) { console.log('fixtures missing — run `npm run callnotes:fixtures` first'); process.exit(1); }

  const files = new Map<string, Buffer>();
  files.set('itest-lm', readFileSync(join(FIX, 'left-message.wav')));
  files.set('itest-neg', readFileSync(join(FIX, 'temp-sell-negotiation.stereo.wav')));
  files.set('itest-lm-old', readFileSync(join(FIX, 'left-message.wav')));
  const pbx = await startFakePbx({ dir: FIX, files, user: 'wfsupport', password: 'secret', pendingHits: 1 });

  // A leftover sidecar on the port (a crashed earlier run) would silently do the work with STALE
  // env — its PBX is gone — and poison every result. Refuse to run behind one.
  try {
    const stale = await fetch(BASE + '/health');
    if (stale.ok) { console.log(`FATAL: something already listens on :${PORT} — kill it first (netstat -ano | findstr :${PORT})`); process.exit(1); }
  } catch { /* nothing listening — good */ }

  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/server.ts'], {
    env: {
      ...process.env, ...QUIET_ENV, PORT: String(PORT), CORS_ORIGINS: 'http://localhost:81',
      AIADVISOR_PBX_SOURCE: 'env', AIADVISOR_PBX_BASE_URL: pbx.url, AIADVISOR_PBX_USER: 'wfsupport', AIADVISOR_PBX_PASSWORD: 'secret',
      AIADVISOR_PBX_FETCH_RETRY_MS: '500', AIADVISOR_CALL_NOTES: '1',
      AIADVISOR_CALL_NOTES_AUTO: '1', AIADVISOR_CALL_NOTES_AUTO_POLL_SECONDS: '3', AIADVISOR_CALL_NOTES_AUTO_LOOKBACK_MINUTES: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const regUser = Number((await query(`SELECT registry_user FROM public.waterfind_user WHERE id = $1`, [CLIENT_UID])).rows[0].registry_user);
  const prim = Number((await query(`SELECT primary_contact_user FROM public.registry_user WHERE id = $1`, [regUser])).rows[0].primary_contact_user);
  const otherReg = Number((await query(`SELECT registry_user FROM public.waterfind_user WHERE id = $1`, [OTHER_CLIENT_UID])).rows[0]?.registry_user ?? 0);
  const stamp = String(Date.now());
  const ids = [999900000301, 999900000302, 999900000303, 999900000304, 999900000305, 999900000306, 999900000307];
  const pcLm = `itest-lm`, pcNeg = `itest-neg`, pcLmOld = `itest-lm-old`, pcNoRec = `itest-norec-${stamp}`, pcShort = `itest-short-${stamp}`, pcLive = `itest-live-${stamp}`;
  const all = [pcLm, pcNeg, pcLmOld, pcNoRec, pcShort, pcLive];
  const contactsBefore = Number((await query(`SELECT count(*)::int AS n FROM public.contact WHERE registry_user = ANY($1::bigint[])`, [[regUser, otherReg]])).rows[0].n);
  try {
    await query(`DELETE FROM call_note WHERE phonecall_id = ANY($1::text[])`, [all]);
    await query(`DELETE FROM public.contact WHERE id = ANY($1::bigint[])`, [ids]);   // strays from a crashed run
    // date_edited is the CRM's NAIVE wall clock: seed it the way the JVM writes it (in the CRM zone).
    const TZ = process.env.AIADVISOR_CRM_TZ || 'Australia/Adelaide';
    await query(`INSERT INTO public.contact (id, registry_user, date_edited, note, added_by, subclass, client_service, phone_record, phonecall_id, call_duration_seconds, incoming_phone_call, phone_number)
                 VALUES ($1, $2, (now() AT TIME ZONE $9) - interval '3 minutes', 'Outgoing Phone Call ', $3, 'C', false, true, $4, 22, false, '0400000011'),
                        ($5, $2, (now() AT TIME ZONE $9) - interval '30 minutes', 'Incoming Phone Call  / Service', $3, 'C', true, true, $6, 80, true, '0400000012'),
                        ($7, $2, (now() AT TIME ZONE $9) - interval '10 minutes', 'Outgoing Phone Call ', $3, 'C', false, true, $8, 60, false, '0400000013'),
                        ($10, $2, (now() AT TIME ZONE $9) - interval '10 minutes', 'Outgoing Phone Call ', $3, 'C', false, true, $11, 5, false, '0400000014'),
                        ($12, $2, (now() AT TIME ZONE $9) - interval '2 minutes', 'Incoming Phone Call ', $3, 'C', false, true, $13, NULL, true, '0400000015')`,
      [ids[0], regUser, STAFF_UID, pcLm, ids[1], pcNeg, ids[2], pcNoRec, TZ, ids[3], pcShort, ids[4], pcLive]);
    // On another client's account: a call the worker will NOT pick up (outside its 60 min lookback) —
    // the popup has to get it drafted on demand.
    const onDemand = otherReg > 0;
    if (onDemand) {
      await query(`INSERT INTO public.contact (id, registry_user, date_edited, note, added_by, subclass, client_service, phone_record, phonecall_id, call_duration_seconds, incoming_phone_call, phone_number)
                   VALUES ($1, $2, (now() AT TIME ZONE $5) - interval '90 minutes', 'Outgoing Phone Call ', $3, 'C', false, true, $4, 22, false, '0400000016')`,
        [ids[5], otherReg, STAFF_UID, pcLmOld, TZ]);
    }

    // boot
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch {} if (!up) await sleep(1000); }
    ok(`sidecar on :${PORT} is up`, up, up ? '' : log.slice(-800));
    if (!up) throw new Error('sidecar did not start');

    // ---- 1. the worker drafts both recorded calls unprompted (and writes nothing to the CRM) ----
    const t0 = Date.now();
    const lm = await waitForDone(pcLm);
    ok('voicemail call drafted automatically', !!lm && lm.status === 'ready' && lm.auto === true,
      lm ? `${lm.status} in ${Math.round((Date.now() - t0) / 1000)}s` : 'no row appeared');
    if (lm && lm.status === 'ready') {
      console.log('     draft:', lm.summary?.note);
      ok('voicemail -> noContact + "message" wording', lm.summary?.noContact === true && /message/i.test(lm.summary?.note ?? ''), lm.summary?.note);
      ok('row attributed to the broker on the call', Number(lm.staff_user_id) === STAFF_UID && Number(lm.client_uid) === prim, `staff=${lm.staff_user_id} client=${lm.client_uid}`);
    }
    const t1 = Date.now();
    const neg = await waitForDone(pcNeg);
    ok('stereo negotiation (incoming) drafted automatically', !!neg && neg.status === 'ready' && neg.direction === 'incoming',
      neg ? `${neg.status} ${neg.direction} in ${Math.round((Date.now() - t1) / 1000)}s` : 'no row appeared');
    if (neg && neg.status === 'ready') {
      console.log('     draft:', neg.summary?.note);
      ok('captures 200ML / $295', /200\s*ML/i.test(neg.summary?.note ?? '') && /295/.test(neg.summary?.note ?? ''), neg.summary?.note);
      ok('stereo transcript labelled by channel', neg.transcript?.diarized === true && neg.transcript?.layout === 'stereo-legs', neg.transcript?.layout);
    }

    // ---- 2. the popup asks: the broker's latest call on this client is the 3-minute-old voicemail ----
    const tok = assistToken(CLIENT_UID, CLIENT_NAME);
    const p = await prefill(tok);
    ok('GET /assist/call-note/prefill -> ready with the voicemail note', p.status === 200 && p.body?.status === 'ready' && p.body.phonecall_id === pcLm && typeof p.body.text === 'string' && p.body.text.length > 10,
      JSON.stringify(p.body).slice(0, 200));
    if (p.body?.status === 'ready') {
      console.log('     prefill:', p.body.text);
      ok('prefill text is the drafted note, ASCII, ends with a call-back', /Call back/.test(p.body.text) && !/[^\x00-\x7F]/.test(p.body.text), p.body.text);
      ok('checks is an array', Array.isArray(p.body.check));
      const row = await noteRow(pcLm);
      ok('hand-off recorded on the row', row?.handed_off_at != null && Number(row.handed_off_by) === STAFF_UID && row.handed_off_note === p.body.text);
    }
    // the broker writes it up -> the popup for the next comment stays empty
    await query(`INSERT INTO public.contact (id, registry_user, date_edited, note, added_by, subclass, client_service, phone_record)
                 VALUES ($1, $2, (now() AT TIME ZONE $4) - interval '1 minute', 'Called and left a message re the season. Call back 03/09', $3, 'C', true, false)`, [ids[6], regUser, STAFF_UID, TZ]);
    const p2 = await prefill(tok);
    ok('after the broker saves a comment -> none', p2.status === 200 && p2.body?.status === 'none', JSON.stringify(p2.body));
    await query(`DELETE FROM public.contact WHERE id = $1`, [ids[6]]);

    // ---- 3. on demand: a call the worker never saw is drafted when the popup asks ----
    if (onDemand) {
      ok('worker left the 90-minute-old call alone (outside its lookback)', (await noteRow(pcLmOld)) === null);
      const tok2 = assistToken(OTHER_CLIENT_UID, OTHER_CLIENT_NAME);
      const first = await prefill(tok2);
      ok('first ask -> drafting (started on demand)', first.status === 200 && first.body?.status === 'drafting' && first.body.phonecall_id === pcLmOld, JSON.stringify(first.body));
      const t2 = Date.now();
      const done = await waitForPrefill(tok2);
      ok('polling ends in ready with the note', done.status === 200 && done.body?.status === 'ready' && /message/i.test(done.body.text || ''),
        `${JSON.stringify(done.body).slice(0, 160)} in ${Math.round((Date.now() - t2) / 1000)}s`);
      const oldRow = await noteRow(pcLmOld);
      ok('on-demand row is not an auto row and is attributed to the broker', !!oldRow && oldRow.auto === false && Number(oldRow.staff_user_id) === STAFF_UID);
    } else {
      console.log('  skip on-demand case: client 119063 has no registry account in this DB');
    }

    // ---- 4. edges: no recording -> failed; short + in-progress never drafted; nothing written to the CRM ----
    const nr = await waitForDone(pcNoRec, 90_000);
    ok('call with no recording -> failed (popup would stay empty)', !!nr && nr.status === 'failed' && nr.error_code === 'recording_not_found', nr ? `${nr.status} ${nr.error_code}` : 'no row appeared');
    await sleep(8000);   // a few poll cycles
    ok('5-second call never drafted', (await noteRow(pcShort)) === null);
    ok('in-progress call never drafted', (await noteRow(pcLive)) === null);
    const contactsAfter = Number((await query(`SELECT count(*)::int AS n FROM public.contact WHERE registry_user = ANY($1::bigint[])`, [[regUser, otherReg]])).rows[0].n);
    ok('the sidecar wrote nothing to public.contact', contactsAfter === contactsBefore + (onDemand ? 6 : 5), `${contactsBefore} -> ${contactsAfter}`);
  } finally {
    // tsx runs the server in a grandchild; on Windows child.kill() leaves it listening on :3101.
    if (process.platform === 'win32' && child.pid) { try { spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' }); } catch {} }
    else child.kill();
    await pbx.close();
    await query(`DELETE FROM call_note_access WHERE call_note_id IN (SELECT id FROM call_note WHERE phonecall_id = ANY($1::text[]))`, [all]);
    await query(`DELETE FROM call_note WHERE phonecall_id = ANY($1::text[])`, [all]);
    await query(`DELETE FROM public.contact WHERE id = ANY($1::bigint[])`, [ids]);
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('--- sidecar log tail ---\n' + log.slice(-3000));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
