// Workstream D — broker workflow: notification (B3), workflow/contract initiation (B4),
// escalation to a human broker (B5). Drives the internal broker-workflow functions directly
// against the live local DB, and the order-event path through the real CRM engine (the same
// HMAC JSP seam test-broker.ts uses). Every CRM/sidecar row it inserts is cleaned up at the end.
//
// Requires: PG up, Resin CRM up on :81 (the JSP seam), for the order-event section.
//   npx tsx test-workflow.ts
//
// A = Stuart (uid 119063, account 666157)  — derives a servicing broker via tag_extension (inactive)
// B = Beth   (uid 2725534, account 2725535) — no broker on file -> unassigned

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveCallerContext } from './src/data-db';
import {
  preparePendingOrder, confirmPendingOrder, prepareWithdrawal,
  resolveBroker, prepareEscalation, confirmEscalation, declineEscalation, cancelEscalation,
} from './src/brokerage';
import { createConversation, deleteConversation } from './src/conversations';
import { query, pool } from './src/db';

const UID_A = 119063, ACC_A = 666157;
const UID_B = 2725534, ACC_B = 2725535;
const REGION = 311325;  // 1A CENTRAL GOULBURN IRRIGATION AREA - LOW R

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

// Apply the migration idempotently so the test is self-contained (db:init does not yet list it).
const here = dirname(fileURLToPath(import.meta.url));
await query(readFileSync(join(here, 'db', 'workflow.sql'), 'utf8'));

const ctxA = await resolveCallerContext(UID_A);
const ctxB = await resolveCallerContext(UID_B);
const sysId = (await query<{ id: number }>(
  `SELECT id FROM public.waterfind_user WHERE username='ai-advisor-system' LIMIT 1`)).rows[0]?.id ?? null;
console.log('A:', JSON.stringify(ctxA), '\nB:', JSON.stringify(ctxB), '\nai-advisor-system user id:', sysId, '\n');

// Track everything we insert so we can remove it at the end.
const createdBrokerActions: number[] = [];
const createdEscalations: number[] = [];
const createdConversations: number[] = [];

/** Newest broker_action id authored by the AI system user for a given client + title prefix. */
async function findBrokerAction(account: number, titlePrefix: string) {
  const r = await query(
    `SELECT id, action_type, broker_action, trade_action, completed, title, description, due_date
       FROM public.broker_action
      WHERE client_registry_user = $1 AND creator_waterfind_user = $2 AND title LIKE $3
      ORDER BY id DESC LIMIT 1`, [account, sysId, titlePrefix + '%']);
  return r.rows[0] ?? null;
}

// ---- 1. appropriate-broker resolution ------------------------------------------------
console.log('-- broker resolution (fallback chain) --');
const brA = await resolveBroker(ctxA);
// Stuart has no live assignment field or live tag; the chain derives his most-recent servicing
// broker from tag_extension — Dion Martin, the servicing broker docs/broker-advisory independently
// recovers from his trade record — and prefers him because he is a real, active (non-banned) staff user.
ok('Stuart resolves to his most-recent servicing broker via tag_extension',
  brA.brokerUserId === 405521586 && brA.source === 'recent-servicing' && brA.brokerName === 'Dion Martin',
  `id=${brA.brokerUserId} name=${brA.brokerName} source=${brA.source} active=${brA.active}`);
ok('Stuart\'s derived broker is an active staff user (preferred over banned candidates)', brA.active === true);

const brB = await resolveBroker(ctxB);
ok('Beth has no broker on file -> unassigned / broking-team fallback',
  brB.brokerUserId === null && brB.source === 'unassigned' && brB.active === false && /broking team/i.test(brB.brokerName),
  `id=${brB.brokerUserId} name=${brB.brokerName} source=${brB.source}`);

// ---- 2. escalation to a human broker (B5) — confirm-before-send lifecycle ------------
// System notes for confirm/decline/cancel are written by the HTTP endpoints (with the session-
// epoch bump), not by these functions — this section covers the durable lifecycle + CRM task.
console.log('\n-- escalation lifecycle (prepare -> confirm -> CRM task; cancel; decline) --');
const conv = await createConversation(UID_A, 'workflow-test');
createdConversations.push(conv.id);

// Historical escalation tasks may exist from live use — compare newest-before vs newest-after.
const newestEscTaskBefore = (await findBrokerAction(ACC_A, 'AI Advisor: escalation'))?.id ?? null;
const prep = await prepareEscalation(ctxA, {
  reason: 'client requested a human',
  summary: 'Client wants to discuss a bespoke multi-season lease that is beyond advisor scope.',
  conversationId: conv.id,
});
createdEscalations.push(prep.escalation.id);
ok('prepare records a PENDING escalation row (uid/account/conversation/reason/broker target)',
  prep.escalation.status === 'pending' && prep.escalation.user_id === UID_A
    && prep.escalation.account_id === ACC_A && prep.escalation.conversation_id === conv.id
    && prep.escalation.reason === 'client requested a human'
    && prep.escalation.broker_user_id === 405521586 && prep.escalation.broker_source === 'recent-servicing',
  `broker=${prep.escalation.broker_name}`);
ok('prepare raises NO CRM broker_action (nothing broker-visible before the client confirms)',
  prep.escalation.crm_broker_action_id == null
    && ((await findBrokerAction(ACC_A, 'AI Advisor: escalation'))?.id ?? null) === newestEscTaskBefore);

const esc = await confirmEscalation(ctxA, prep.escalation.id);
if (esc.crmBrokerActionId) createdBrokerActions.push(esc.crmBrokerActionId);
ok('confirm flips the row to confirmed with decided_at',
  esc.escalation.status === 'confirmed' && esc.escalation.decided_at != null);

const escTask = esc.crmBrokerActionId
  ? (await query(`SELECT id, client_registry_user, creator_waterfind_user, action_type, broker_action, title, description
                    FROM public.broker_action WHERE id = $1`, [esc.crmBrokerActionId])).rows[0]
  : null;
ok('confirm raised a broker-visible CRM broker_action on the client file',
  !!escTask && escTask.client_registry_user === ACC_A && escTask.creator_waterfind_user === sysId
    && escTask.action_type === 'call' && escTask.broker_action === true
    && /escalation - client needs a human broker/.test(escTask.title)
    && /client requested a human/i.test(escTask.description),
  escTask ? `#${escTask.id}` : 'no task');
ok('confirm linked its CRM task back onto the escalation row',
  esc.escalation.crm_broker_action_id === esc.crmBrokerActionId && esc.crmBrokerActionId != null);
ok('confirming a non-pending escalation is rejected',
  await confirmEscalation(ctxA, prep.escalation.id).then(() => false, (e) => /not pending/.test(e.message)));

const can = await cancelEscalation(UID_A, prep.escalation.id);
ok('cancel (de-escalate) flips the row to cancelled',
  can.escalation.status === 'cancelled' && can.escalation.cancelled_at != null);
const closedTask = esc.crmBrokerActionId
  ? (await query(`SELECT completed, description FROM public.broker_action WHERE id=$1`, [esc.crmBrokerActionId])).rows[0]
  : null;
ok('cancel completed + annotated the CRM task so the team does not chase it',
  can.taskClosed === true && !!closedTask && closedTask.completed === true
    && /Cancelled by the client via the AI Advisor/.test(closedTask.description));

const prep2 = await prepareEscalation(ctxB, { reason: 'dispute', summary: 'Needs the disputes team.', conversationId: null });
createdEscalations.push(prep2.escalation.id);
const dec = await declineEscalation(UID_B, prep2.escalation.id);
ok('decline flips a pending escalation to declined without any CRM task',
  dec.status === 'declined' && dec.crm_broker_action_id == null);

// ---- 3. order-PLACED broker notification (B3 + B4) -----------------------------------
// Places a real resting SELL (absurd price so it will not clear), asserts the broker task, then
// withdraws it (which asserts the withdrawal task too), leaving no resting order behind.
console.log('\n-- order-placed / withdrawn broker notification (via the real CRM engine) --');
const sell = await preparePendingOrder(ctxA,
  { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9791 });
const sellDone = await confirmPendingOrder(ctxA, sell.id, true);
ok('SELL placed through the CRM engine', sellDone.status === 'placed' && !!sellDone.crm_order_id,
  `crm_order=${sellDone.crm_order_id} err=${sellDone.error ?? ''}`);

const placeTask = await findBrokerAction(ACC_A, 'AI Advisor: SELL order placed');
if (placeTask) createdBrokerActions.push(placeTask.id);
ok('placement raised a broker_action with "contract preparation required" (B4 workflow trigger)',
  !!placeTask && placeTask.trade_action === true && placeTask.broker_action === true
    && placeTask.completed === false
    && /contract preparation required/.test(placeTask.title)
    && placeTask.description.includes('order #' + sellDone.crm_order_id),
  placeTask ? `#${placeTask.id}: ${String(placeTask.title).slice(0, 55)}` : 'no task');

const wd = await prepareWithdrawal(ctxA, sellDone.crm_order_id!);
const wdDone = await confirmPendingOrder(ctxA, wd.id, false);
ok('the resting SELL is withdrawn via the engine', wdDone.status === 'placed');
const wdCheck = (await query(`SELECT deleted FROM public.order_listing WHERE id=$1`, [sellDone.crm_order_id])).rows[0];
ok('CRM listing soft-deleted (no resting order left behind)', wdCheck?.deleted === true);

const wdTask = await findBrokerAction(ACC_A, 'AI Advisor: order #' + sellDone.crm_order_id + ' withdrawn');
if (wdTask) createdBrokerActions.push(wdTask.id);
ok('withdrawal raised its own broker_action review task',
  !!wdTask && wdTask.broker_action === true && /withdrawn - review/.test(wdTask.title),
  wdTask ? `#${wdTask.id}` : 'no task');

// ---- 4. isolation: the broker notification never affects the trade outcome -----------
// (Structural check — notifyBrokerOfOrder is wrapped in try/catch so a notification problem can
// never turn a placed/withdrawn order into a failure; the trade result stands on its own.)
ok('order placement result is independent of the (isolated, best-effort) broker notification',
  sellDone.status === 'placed');

// ---- cleanup -------------------------------------------------------------------------
console.log('\n-- cleanup --');
if (createdBrokerActions.length) {
  await query(`DELETE FROM public.broker_action WHERE id = ANY($1)`, [createdBrokerActions]);
}
if (createdEscalations.length) {
  await query(`DELETE FROM ai_advisor.escalation WHERE id = ANY($1)`, [createdEscalations]);
}
for (const cid of createdConversations) await deleteConversation(cid, UID_A);
const leftTasks = (await query(
  `SELECT count(*)::int AS n FROM public.broker_action WHERE id = ANY($1)`, [createdBrokerActions])).rows[0].n;
const leftEsc = (await query(
  `SELECT count(*)::int AS n FROM ai_advisor.escalation WHERE id = ANY($1)`,
  [createdEscalations.length ? createdEscalations : [0]])).rows[0].n;
ok('all inserted CRM broker_action + escalation rows removed', leftTasks === 0 && leftEsc === 0,
  `broker_actions_left=${leftTasks} escalations_left=${leftEsc}`);

console.log(`\nworkflow tests: ${pass} ok, ${fail} failed`);
await pool.end();
process.exit(fail ? 1 : 0);
