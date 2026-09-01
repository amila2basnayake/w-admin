/**
 * Call campaigns (src/voice/campaigns.ts + campaign-routes.ts): brief validation, the list builder,
 * eligibility, members, the lifecycle (launch → feed → dial (stubbed) → settle → complete), pause /
 * resume / cancel semantics against the real outbound queue, duplicate, and the HTTP gate.
 *   npm run test:campaigns
 * Needs the local DB (ai_advisor.voice_* + voice_campaign* tables). No network, no Retell: the dialer's
 * placeCall is stubbed and calls are closed with synthetic webhook events.
 */
process.env.AIADVISOR_SPEND_LEDGER = '0';
import './test/voice-test-env';
import express from 'express';
import crypto from 'node:crypto';
import * as camp from './src/voice/campaigns';
import { _setPlaceCall, dialDue } from './src/voice/outbound';
import { handleRetellEvent } from './src/voice/webhooks';
import { voiceConfig } from './src/voice/config';
import { voiceRouter } from './src/voice/routes';
import { config } from './src/config';
import { pool } from './src/db';

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }
function eq(a: unknown, b: unknown, msg: string) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
async function throws(fn: () => Promise<unknown>, status: number, msg: string, re?: RegExp) {
  try { await fn(); ok(false, `${msg}: did not throw`); }
  catch (e: any) { ok(e?.status === status && (!re || re.test(e.message)), `${msg} (got ${e?.status} ${e?.message})`); }
}

const STUART = 119063;   // client; crn 2140; account 666157; primary contact
const BETH = 2725534;    // client; account 2725535; primary contact
const ADMIN = 10;        // staff (admin, SU)
const STAFF = { uid: ADMIN, name: 'Test Admin' };
const created: number[] = [];

function mint(uid: number, name: string, ut: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ uid, name, ut, iat: now, exp: now + 600, nonce: 'n' }), 'utf8').toString('base64url');
  return body + '.' + crypto.createHmac('sha256', config.sharedSecret).update(body).digest('base64url');
}

async function cleanup() {
  for (const id of created) {
    const reqs = await camp.campaignRequests(id);
    for (const r of reqs) {
      await pool.query(`DELETE FROM voice_call_event WHERE call_id IN (SELECT id FROM voice_call WHERE outbound_request_id=$1)`, [r.id]);
      await pool.query(`DELETE FROM voice_call WHERE outbound_request_id=$1`, [r.id]);
    }
    await pool.query(`DELETE FROM voice_outbound_request WHERE source=$1`, [`campaign:${id}`]);
    await pool.query(`DELETE FROM voice_campaign WHERE id=$1`, [id]);
  }
}

// The sanitised dev DB has both test clients opted OUT of campaigns (registry_user.campaign_optin,
// the CRM's "include in campaigns" setting). The suite opts them in for its duration and restores.
let optinBefore: Array<{ id: number; campaign_optin: boolean }> = [];
async function optInTestClients() {
  optinBefore = (await pool.query(`SELECT ru.id, ru.campaign_optin FROM registry_user ru JOIN waterfind_user wu ON wu.registry_user = ru.id WHERE wu.id = ANY($1::bigint[])`, [[STUART, BETH]])).rows;
  await pool.query(`UPDATE registry_user SET campaign_optin = true WHERE id = ANY($1::bigint[])`, [optinBefore.map((r) => r.id)]);
}
async function restoreOptin() {
  for (const r of optinBefore) await pool.query(`UPDATE registry_user SET campaign_optin = $2 WHERE id = $1`, [r.id, r.campaign_optin]);
}

async function main() {
  // Any leftovers from an aborted run.
  const stale = await pool.query(`SELECT id FROM voice_campaign WHERE name LIKE 'test:%'`);
  created.push(...stale.rows.map((r: any) => r.id));
  await cleanup(); created.length = 0;

  // opt-out is honoured before anything else
  {
    const e0 = await camp.checkEligibility([STUART]);
    const before = optinBefore.length ? null : (await pool.query(`SELECT ru.campaign_optin FROM registry_user ru JOIN waterfind_user wu ON wu.registry_user = ru.id WHERE wu.id=$1`, [STUART])).rows[0]?.campaign_optin;
    if (before === false) ok(e0.get(STUART)?.ok === false && e0.get(STUART)!.reasons.some((r) => /opted out/.test(r)), 'CRM campaign opt-out makes a client ineligible');
  }
  await optInTestClients();

  // ---- 1. brief validation --------------------------------------------------------------------
  {
    const p = camp.normalisePayload({ message: '  hello\nworld  ', broker_name: 'X'.repeat(600), region: 'Goulburn', junk: 'ignored', callback_number: '+61812345678' });
    eq(p.message, 'hello world', 'message flattened');
    eq(p.broker_name.length, 500, 'broker_name capped');
    eq((p as any).junk, undefined, 'unknown payload keys dropped');
    eq(p.callback_number, '+61812345678', 'transfer number allowed as callback');
    let err: any = null; try { camp.normalisePayload({ callback_number: '+61499999999' }); } catch (e) { err = e; }
    eq(err?.status, 400, 'arbitrary callback number rejected');
    await throws(() => camp.createCampaign({ name: 'test:x', flow: 'order_confirmation' }, STAFF), 400, 'order_confirmation is not a campaign flow');
    await throws(() => camp.createCampaign({ name: '', flow: 'market_alert' }, STAFF), 400, 'name required');
    await throws(() => camp.createCampaign({ name: 'test:x', flow: 'market_alert', scheduled_for: 'nope' }, STAFF), 400, 'bad schedule');
    await throws(() => camp.createCampaign({ name: 'test:x', flow: 'market_alert', max_concurrent: 0 }, STAFF), 400, 'concurrency floor');
    ok(camp.openingFor('market_alert').includes('automated assistant') && camp.openingFor('market_alert').includes('market update for your region'), 'opening line per flow');
  }

  // ---- 2. create + brief defaults ---------------------------------------------------------------
  const c1 = await camp.createCampaign({ name: 'test:one', flow: 'broker_followup', payload: { message: 'Checking in about carryover' } }, STAFF);
  created.push(c1.id);
  eq(c1.status, 'draft', 'new campaign is a draft');
  eq(c1.payload.broker_name, 'Test Admin', 'broker_name defaults to the creating staff member');
  eq(c1.max_concurrent, voiceConfig.campaignMaxConcurrent, 'default concurrency from config');
  const c1b = await camp.updateCampaign(c1.id, { name: 'test:one renamed', max_concurrent: 1, payload: { message: 'Updated brief', broker_name: 'Dion' } });
  eq(c1b.name, 'test:one renamed', 'rename');
  eq(c1b.max_concurrent, 1, 'concurrency edit');
  eq(c1b.payload.broker_name, 'Dion', 'payload edit');

  // ---- 3. list builder --------------------------------------------------------------------------
  {
    await throws(() => camp.searchClients({}), 400, 'search needs a filter');
    const byName = await camp.searchClients(camp.parseClientFilter({ q: 'Hodge' }));
    ok(byName.some((h) => h.uid === STUART), 'search by surname finds Stuart');
    const byId = await camp.searchClients(camp.parseClientFilter({ q: String(STUART) }));
    eq(byId.length >= 1 && byId[0].uid, STUART, 'search by client id');
    const byCrn = await camp.searchClients(camp.parseClientFilter({ q: '2140' }));
    ok(byCrn.some((h) => h.uid === STUART && h.crn === 2140), 'search by CRN resolves the account primary contact');
    const hit = byId[0];
    ok(typeof hit.name === 'string' && hit.name === 'Stuart Hodge', `display name collapsed whitespace (${hit.name})`);
    ok(hit.phone_tail === '…136', `phone tail (${hit.phone_tail})`);
    ok(Array.isArray(hit.zones) && hit.licences >= 0, 'zones + licence count present');
    eq(hit.crn, 2140, 'CRN from waterfind_user.crn');
    ok(typeof hit.advisor_on === 'boolean' && typeof hit.campaign_optin === 'boolean' && hit.suppressed === false, 'flags present');
    const opts = await camp.campaignOptions();
    ok(opts.flows.length === 3 && opts.flows.every((f) => f.opening), 'options: 3 flows with openings');
    ok(opts.states.length > 20, `options: states (${opts.states.length})`);
    ok(opts.brokers.length > 5 && opts.brokers[0].accounts >= opts.brokers[1].accounts, 'options: brokers by account count');
    ok(opts.callback_numbers.includes('+61812345678'), 'options: callback numbers include the transfer number');
    eq(opts.calling_hours, '00:00–24:00', 'options: calling hours from config');
    // state + region narrow to Stuart
    const stateRow = await pool.query(`SELECT r.state, p.region FROM property p JOIN region r ON r.id=p.region WHERE p.registry_user=666157 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.sub_type='REG' LIMIT 1`);
    if (stateRow.rows[0]) {
      const st = Number(stateRow.rows[0].state), rg = Number(stateRow.rows[0].region);
      const inState = await camp.searchClients(camp.parseClientFilter({ q: 'Hodge', state_id: String(st) }));
      ok(inState.some((h) => h.uid === STUART), 'state filter keeps Stuart');
      const inRegion = await camp.searchClients(camp.parseClientFilter({ q: 'Hodge', region_id: String(rg) }));
      ok(inRegion.some((h) => h.uid === STUART), 'region filter keeps Stuart');
      const wrong = await camp.searchClients(camp.parseClientFilter({ q: 'Hodge', region_id: '-1' }));
      ok(!wrong.some((h) => h.uid === STUART), 'other region excludes Stuart');
      const regions = await camp.regionsOfState(st);
      ok(regions.some((r) => r.id === rg), 'regionsOfState lists the zone');
    }
    const big = await camp.searchClients(camp.parseClientFilter({ min_ml: '5000', limit: '5' }));
    ok(big.length <= 5 && big.every((h) => (h.volume_ml ?? 0) >= 5000), 'min_ml + limit');
  }

  // ---- 4. eligibility + members -----------------------------------------------------------------
  {
    const e = await camp.checkEligibility([STUART, BETH, ADMIN, 1]);
    ok(e.get(STUART)?.ok === true && e.get(STUART)?.phone === '+61451087136', 'Stuart eligible with his mobile');
    ok(e.get(ADMIN)?.ok === false && e.get(ADMIN)!.reasons.includes('not a client account'), 'staff account is not eligible');
    ok(!e.has(1), 'unknown uid absent');
    const add = await camp.addMembers(c1.id, { client_uids: [STUART, ADMIN, 'abc', 1], crns: [2140, 999999999] }, ADMIN);
    eq(add.added, 2, 'two members added (Stuart once — the CRN is his account)');
    eq(add.skipped, 1, 'the staff account is on the list as skipped');
    ok(add.unknown.length === 3, `unknown ids reported (${JSON.stringify(add.unknown)})`);
    const again = await camp.addMembers(c1.id, { client_uids: [STUART] }, ADMIN);
    eq(again.already, 1, 're-adding is a no-op');
    let d = await camp.campaignDetail(c1.id);
    eq(d.members.length, 2, 'detail lists members');
    ok(typeof d.members.find((m) => m.client_uid === STUART)?.zone === 'string', 'member carries a market zone');
    eq(d.counts.pending, 1, 'one pending'); eq(d.counts.skipped, 1, 'one skipped');
    ok(d.members.find((m) => m.client_uid === ADMIN)?.skip_reason?.includes('not a client account'), 'skip reason recorded');
    eq(await camp.removeMember(c1.id, ADMIN), true, 'skipped member removable');
    eq(await camp.removeMember(c1.id, 424242), false, 'removing a non-member is false');
    await camp.addMembers(c1.id, { client_uids: [BETH] }, ADMIN);
    d = await camp.campaignDetail(c1.id);
    eq(d.counts.total, 2, 'Stuart + Beth');
    // a suppressed number becomes ineligible on recheck
    await pool.query(`INSERT INTO voice_suppression (phone_digits, reason, source) VALUES ('61451087136','manual','test') ON CONFLICT (phone_digits) DO NOTHING`);
    const rc = await camp.recheckMembers(c1.id);
    eq(rc.skipped, 1, 'recheck skips the suppressed number');
    await pool.query(`DELETE FROM voice_suppression WHERE phone_digits='61451087136' AND source='test'`);
    const rc2 = await camp.recheckMembers(c1.id);
    eq(rc2.eligible, 2, 'recheck restores eligibility once unsuppressed');
  }

  // ---- 5. lifecycle: launch → feed → dial (stub) → settle → complete ---------------------------------
  const placed: Array<{ id: number; call_id: string }> = [];
  _setPlaceCall(async (req) => { const call_id = `test_camp_${req.id}_${Date.now()}`; placed.push({ id: req.id, call_id }); return { call_id, agent_id: 'agent_test' }; });
  const savedCfg = { outboundEnabled: voiceConfig.outboundEnabled, fromNumber: voiceConfig.fromNumber, outboundAgentId: voiceConfig.outboundAgentId };
  Object.assign(voiceConfig, { outboundEnabled: true, fromNumber: '+61400000000', outboundAgentId: 'agent_test' });
  async function endCall(call_id: string, reason = 'user_hangup') {
    await handleRetellEvent({ event: 'call_ended', call: { call_id, call_status: 'ended', disconnection_reason: reason, end_timestamp: Date.now(), duration_ms: 65_000, transcript_object: [] } } as any);
  }
  try {
    await throws(() => camp.pauseCampaign(c1.id), 409, 'cannot pause a draft');
    const launched = await camp.launchCampaign(c1.id, ADMIN);
    eq(launched.status, 'running', 'launched');
    await throws(() => camp.launchCampaign(c1.id, ADMIN), 409, 'cannot launch twice');
    await throws(() => camp.updateCampaign(c1.id, { flow: 'market_alert' }), 409, 'flow locked after launch');
    await throws(() => camp.deleteCampaign(c1.id), 409, 'running campaign cannot be deleted');

    // scheduled in the future → nothing fed
    await camp.updateCampaign(c1.id, { scheduled_for: new Date(Date.now() + 3600_000).toISOString() });
    let f = await camp.feedCampaign((await camp.getCampaign(c1.id))!);
    eq(f.fed, 0, 'schedule in the future feeds nothing'); ok(!!f.waiting, 'waiting reason given');
    await camp.updateCampaign(c1.id, { scheduled_for: null });

    // max_concurrent = 1: one member fed, the other waits
    f = await camp.feedCampaign((await camp.getCampaign(c1.id))!);
    eq(f.fed, 1, 'feeds one (max_concurrent 1)'); eq(f.inflight, 1, 'one in flight');
    let d = await camp.campaignDetail(c1.id);
    eq(d.counts.queued, 1, 'member queued'); eq(d.counts.pending, 1, 'member pending');
    const first = d.members.find((m) => m.state === 'queued')!;
    ok(first.outbound_request_id != null && first.to_number?.startsWith('+61'), 'request id + resolved number on the member');
    const reqs = await camp.campaignRequests(c1.id);
    eq(reqs.length, 1, 'one outbound request');
    eq(reqs[0].idempotency_key, `campaign:${c1.id}:${first.id}:1`, 'idempotency key names campaign/member/feed');
    eq(reqs[0].payload.message, 'Updated brief', 'brief carried on the request');
    eq(reqs[0].payload.broker_name, 'Dion', 'broker_name carried');
    f = await camp.feedCampaign((await camp.getCampaign(c1.id))!);
    eq(f.fed, 0, 'no room → nothing more fed');

    // the dialer picks it up (guards pass: hours 00-24, flag on, cap 2, no suppression)
    const dialed = await dialDue(10);
    ok(dialed.some((x) => x.id === reqs[0].id && x.result.startsWith('dialing')), `dialer dialed the campaign request (${JSON.stringify(dialed)})`);
    d = await camp.campaignDetail(c1.id);
    eq(d.members.find((m) => m.id === first.id)?.state, 'dialing', 'member shows dialing');
    // pause while a call is in flight: nothing to withdraw, campaign paused
    const paused = await camp.pauseCampaign(c1.id);
    eq(paused.status, 'paused', 'paused');
    f = await camp.feedCampaign((await camp.getCampaign(c1.id))!);   // feedCampaign is status-agnostic; the tick gates on status
    // (tick) — paused campaigns are not fed
    await camp.resumeCampaign(c1.id);
    // the call ends → request completed → member called
    await endCall(placed[0].call_id);
    d = await camp.campaignDetail(c1.id);
    const done = d.members.find((m) => m.id === first.id)!;
    eq(done.state, 'called', 'member called after the call ended');
    eq(done.duration_seconds, 65, 'duration from the call');
    ok(!!done.call_id, 'call id linked');

    // next feed: room again → the second member is fed
    const ticks = await camp.campaignTick();
    const mine = ticks.find((t) => t.campaign_id === c1.id)!;
    eq(mine.fed, 1, 'tick feeds the second member');
    d = await camp.campaignDetail(c1.id);
    const second = d.members.find((m) => m.state === 'queued')!;
    ok(!!second, 'second member queued');

    // pause with a QUEUED (not yet dialed) request: withdrawn, member back to pending
    await camp.pauseCampaign(c1.id);
    d = await camp.campaignDetail(c1.id);
    eq(d.members.find((m) => m.id === second.id)?.state, 'pending', 'queued request withdrawn on pause → member pending');
    const withdrawn = (await camp.campaignRequests(c1.id)).find((r) => r.id === second.outbound_request_id)!;
    eq(withdrawn.status, 'cancelled', 'the request row is cancelled');
    // while paused, the tick feeds nothing
    const pausedTick = await camp.campaignTick();
    ok(!pausedTick.some((t) => t.campaign_id === c1.id), 'paused campaign not fed by the tick');
    await camp.resumeCampaign(c1.id);
    const t2 = await camp.campaignTick();
    eq(t2.find((t) => t.campaign_id === c1.id)?.fed, 1, 'resume re-feeds');
    d = await camp.campaignDetail(c1.id);
    const refed = d.members.find((m) => m.id === second.id)!;
    eq(refed.feed_count, 2, 'feed_count incremented');
    const reqs2 = await camp.campaignRequests(c1.id);
    ok(reqs2.some((r) => r.idempotency_key === `campaign:${c1.id}:${second.id}:2`), 'new idempotency key on re-feed');

    // dial + no answer → the dialer's own retry re-queues; then end as completed
    await dialDue(10);
    const lastPlaced = placed[placed.length - 1];
    await endCall(lastPlaced.call_id, 'dial_no_answer');
    d = await camp.campaignDetail(c1.id);
    const retry = d.members.find((m) => m.id === second.id)!;
    eq(retry.state, 'queued', 'no-answer re-queued by the dialer retry');
    ok(/retry/.test(retry.req_detail ?? ''), `retry detail (${retry.req_detail})`);
    // force the retry due now and dial again, then a voicemail outcome
    await pool.query(`UPDATE voice_outbound_request SET scheduled_for = now() WHERE id=$1`, [retry.outbound_request_id]);
    await dialDue(10);
    await endCall(placed[placed.length - 1].call_id, 'voicemail_reached');
    d = await camp.campaignDetail(c1.id);
    eq(d.members.find((m) => m.id === second.id)?.state, 'voicemail', 'voicemail outcome shown');
    // everything settled → the next tick completes the campaign
    const t3 = await camp.campaignTick();
    eq(t3.find((t) => t.campaign_id === c1.id)?.completed, true, 'campaign completes when nothing is pending or in flight');
    eq((await camp.getCampaign(c1.id))!.status, 'completed', 'status completed');
    ok(!!(await camp.getCampaign(c1.id))!.finished_at, 'finished_at set');
    await throws(() => camp.addMembers(c1.id, { client_uids: [STUART] }, ADMIN), 409, 'completed campaign is read-only');
    const list = await camp.listCampaigns();
    const mineL = list.find((c) => c.id === c1.id)!;
    eq(mineL.counts.called, 1, 'list counts: called'); eq(mineL.counts.voicemail, 1, 'list counts: voicemail'); eq(mineL.counts.total, 2, 'list counts: total');

    // ---- 6. cancel + duplicate ----------------------------------------------------------------
    const c2 = await camp.duplicateCampaign(c1.id, STAFF);
    created.push(c2.id);
    eq(c2.status, 'draft', 'duplicate is a draft');
    eq(c2.name, 'test:one renamed (copy)', 'duplicate name');
    let d2 = await camp.campaignDetail(c2.id);
    eq(d2.counts.pending, 2, 'duplicate carries the list as pending');
    eq(d2.payload.message, 'Updated brief', 'duplicate carries the brief');
    await camp.launchCampaign(c2.id, ADMIN);
    await camp.updateCampaign(c2.id, { max_concurrent: 1 });
    await camp.campaignTick();
    d2 = await camp.campaignDetail(c2.id);
    eq(d2.counts.queued, 1, 'one queued before cancel');
    const cancelled = await camp.cancelCampaign(c2.id);
    eq(cancelled.status, 'cancelled', 'cancelled');
    d2 = await camp.campaignDetail(c2.id);
    eq(d2.counts.cancelled, 2, 'pending member AND the withdrawn (never dialed) member both cancelled');
    eq(d2.counts.pending, 0, 'nothing left waiting');
    ok((await camp.campaignRequests(c2.id)).every((r) => r.status === 'cancelled'), 'all its requests cancelled');
    await throws(() => camp.resumeCampaign(c2.id), 409, 'cannot resume a cancelled campaign');

    // ---- 7. launch guard: no eligible members -------------------------------------------------
    const c3 = await camp.createCampaign({ name: 'test:empty', flow: 'market_alert' }, STAFF);
    created.push(c3.id);
    await throws(() => camp.launchCampaign(c3.id, ADMIN), 400, 'launch with no eligible clients');
    await camp.addMembers(c3.id, { client_uids: [ADMIN] }, ADMIN);
    await throws(() => camp.launchCampaign(c3.id, ADMIN), 400, 'launch with only skipped clients');
    await camp.deleteCampaign(c3.id);
    eq(await camp.getCampaign(c3.id), null, 'draft deleted');
  } finally {
    Object.assign(voiceConfig, savedCfg);
  }

  // ---- 8. HTTP gate ---------------------------------------------------------------------------------
  {
    const app = express();
    app.use(express.json());
    app.use('/voice', voiceRouter);
    const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}/voice/campaigns`;
    const get = (path: string, tok?: string) => fetch(base + path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
    eq((await get('')).status, 401, 'no token → 401');
    eq((await get('', mint(STUART, 'Stuart', 0))).status, 403, 'client token → 403');
    eq((await get('', 'garbage')).status, 401, 'bad token → 401');
    const staffTok = mint(ADMIN, 'Admin', 3);
    const r = await get('', staffTok);
    eq(r.status, 200, 'staff token → 200');
    ok(Array.isArray(await r.json()), 'list is an array');
    eq((await get('/clients', staffTok)).status, 400, 'clients without a filter → 400');
    const cl = await get('/clients?q=Hodge', staffTok);
    eq(cl.status, 200, 'clients search 200');
    const created4 = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${staffTok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test:http', flow: 'market_alert', payload: { message: 'hi', region: 'Goulburn' } }) });
    eq(created4.status, 201, 'create via HTTP');
    const c4 = await created4.json();
    created.push(c4.id);
    eq(c4.created_by_name, 'Admin', 'created_by_name from the token');
    const bad = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${staffTok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test:bad', flow: 'nope' }) });
    eq(bad.status, 400, 'bad flow via HTTP → 400');
    eq((await get('/999999999', staffTok)).status, 404, 'unknown campaign → 404');
    const det = await get(`/${c4.id}`, staffTok);
    const dj = await det.json();
    ok(dj.opening?.includes('market update'), 'detail carries the opening line');
    await new Promise<void>((r) => server.close(() => r()));
  }

  await cleanup();
  await restoreOptin();
  console.log(`\ncampaigns: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); try { await cleanup(); await restoreOptin(); } catch {} process.exit(1); });
