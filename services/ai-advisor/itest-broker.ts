// HTTP integration test for the brokerage confirm flow: bearer-token auth, per-user
// isolation (IDOR), the T&C gate, execution through the CRM engine, and the authoritative
// system notes written back into the conversation.
//
// Requires: sidecar on :3100, CRM on :81, PG up.   npx tsx itest-broker.ts

import crypto from 'node:crypto';
import { config } from './src/config';
import { resolveCallerContext } from './src/data-db';
import { preparePendingOrder, prepareWithdrawal } from './src/brokerage';

const BASE = `http://localhost:${config.port}`;
const UID_A = 119063, UID_B = 2725534, REGION = 311325;

function mint(uid: number, name: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { uid, name, ut: 1, iat: now, exp: now + config.tokenTtl, nonce: crypto.randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', config.sharedSecret).update(body).digest('base64url');
  return body + '.' + sig;
}
const tokA = mint(UID_A, 'Stuart'), tokB = mint(UID_B, 'Beth');

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

// conversation for A so order events land somewhere visible
const conv = (await api(tokA, 'POST', '/conversations', { title: 'broker itest' })).json;
const ctxA = await resolveCallerContext(UID_A);

// pending order tied to the conversation (as the agent tool would create it)
const po = await preparePendingOrder(ctxA, {
  side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9997,
  conversationId: conv.id,
});

// listing + isolation
const listA = await api(tokA, 'GET', `/orders?conversation_id=${conv.id}&status=pending`);
ok('A sees own pending order via HTTP', listA.status === 200 && listA.json.some((o: any) => o.id === po.id));
const listB = await api(tokB, 'GET', '/orders');
ok('B order list excludes A orders', listB.status === 200 && !listB.json.some((o: any) => o.id === po.id));
const confB = await api(tokB, 'POST', `/orders/${po.id}/confirm`, { tc_accepted: true });
ok('IDOR: B cannot confirm A order (404)', confB.status === 404);
const noAuth = await fetch(`${BASE}/orders/${po.id}/confirm`, { method: 'POST' });
ok('no token -> 401', noAuth.status === 401);

// T&C gate over HTTP
const noTc = await api(tokA, 'POST', `/orders/${po.id}/confirm`, { tc_accepted: false });
ok('confirm without T&C -> 400', noTc.status === 400, noTc.json?.error);

// real confirm
const confA = await api(tokA, 'POST', `/orders/${po.id}/confirm`, { tc_accepted: true });
ok('A confirm places through the engine', confA.status === 200 && confA.json.status === 'placed'
  && !!confA.json.crm_order_id, `crm_order=${confA.json?.crm_order_id}`);

// idempotent re-confirm
const confA2 = await api(tokA, 'POST', `/orders/${po.id}/confirm`, { tc_accepted: true });
ok('re-confirm is idempotent (same CRM order)', confA2.json?.crm_order_id === confA.json?.crm_order_id);

// system note recorded in the conversation
let msgs = (await api(tokA, 'GET', `/conversations/${conv.id}/messages`)).json;
ok('PLACED system note recorded in conversation',
  msgs.some((m: any) => m.role === 'system' && /PLACED.*#\d+/.test(m.content)),
  msgs.filter((m: any) => m.role === 'system').map((m: any) => m.content).join(' | ').slice(0, 120));

// withdrawal via HTTP (no T&C needed) + its system note
const wd = await prepareWithdrawal(ctxA, confA.json.crm_order_id, conv.id);
const wdConf = await api(tokA, 'POST', `/orders/${wd.id}/confirm`, {});
ok('withdrawal confirm succeeds', wdConf.status === 200 && wdConf.json.status === 'placed');
msgs = (await api(tokA, 'GET', `/conversations/${conv.id}/messages`)).json;
ok('WITHDRAWN system note recorded', msgs.some((m: any) => m.role === 'system' && /WITHDRAWN/.test(m.content)));

// decline flow + note
const po2 = await preparePendingOrder(ctxA, {
  side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9996, conversationId: conv.id,
});
const dec = await api(tokA, 'POST', `/orders/${po2.id}/cancel`);
ok('decline works', dec.status === 200 && dec.json.status === 'cancelled');
msgs = (await api(tokA, 'GET', `/conversations/${conv.id}/messages`)).json;
ok('DECLINED system note recorded', msgs.some((m: any) => m.role === 'system' && /DECLINED/.test(m.content)));

// cleanup
await api(tokA, 'DELETE', `/conversations/${conv.id}`);

// ---- broker-assist (Client Rail): staff confirms / declines FOR the client ---------------------
// Staff token with an `act` claim for A (what the client-page JSP mints). The order rows are the
// client's; only cards staged from THIS client's assist file are actionable through /assist.
console.log('\n-- broker-assist routes --');
const STAFF_UID = 10; // Administrator (SU) — admitted by ASSIST_ROLES
function mintStaff(actUid: number, actName: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { uid: STAFF_UID, name: 'Test Staff', ut: 3, iat: now, exp: now + config.tokenTtl,
    nonce: crypto.randomBytes(8).toString('hex'), act: actUid, actName };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', config.sharedSecret).update(body).digest('base64url');
  return body + '.' + sig;
}
const tokStaffA = mintStaff(UID_A, 'Stuart'), tokStaffB = mintStaff(UID_B, 'Beth');
const ON_BEHALF = { staffUid: STAFF_UID, staffName: 'Test Staff' };

const aconv = (await api(tokStaffA, 'POST', '/assist/conversations', { title: 'assist broker itest' })).json;
ok('staff opens an assist chat about A', aconv?.id > 0);
// staged as the assist-surface tool would (ctx = client, onBehalf = staff, conversation = assist chat)
const apo = await preparePendingOrder(ctxA, {
  side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9995,
  conversationId: aconv.id, onBehalf: ON_BEHALF,
});
const alist = await api(tokStaffA, 'GET', `/assist/orders?conversation_id=${aconv.id}&status=pending`);
ok('staff lists the pending card for the assist chat', alist.status === 200 && alist.json.some((o: any) => o.id === apo.id));
ok('conversation_id is required', (await api(tokStaffA, 'GET', '/assist/orders')).status === 400);
ok('a client token cannot use the assist routes (403)', (await api(tokA, 'GET', `/assist/orders?conversation_id=${aconv.id}`)).status === 403);
ok('staff acting for B cannot list A\'s assist chat (404)', (await api(tokStaffB, 'GET', `/assist/orders?conversation_id=${aconv.id}`)).status === 404);
ok('staff acting for B cannot confirm A\'s card (404)', (await api(tokStaffB, 'POST', `/assist/orders/${apo.id}/confirm`, { tc_accepted: true })).status === 404);
// a card pending in the CLIENT's OWN chat is not the broker's to confirm
const cconv = (await api(tokA, 'POST', '/conversations', { title: 'client own chat' })).json;
const cpo = await preparePendingOrder(ctxA, {
  side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9994, conversationId: cconv.id,
});
ok('a card in the client\'s own chat is not actionable from the rail (404)',
  (await api(tokStaffA, 'POST', `/assist/orders/${cpo.id}/confirm`, { tc_accepted: true })).status === 404);
ok('...nor declinable from the rail (404)', (await api(tokStaffA, 'POST', `/assist/orders/${cpo.id}/cancel`)).status === 404);
await api(tokA, 'POST', `/orders/${cpo.id}/cancel`);
await api(tokA, 'DELETE', `/conversations/${cconv.id}`);

const noTcS = await api(tokStaffA, 'POST', `/assist/orders/${apo.id}/confirm`, { tc_accepted: false });
ok('assist confirm without the T&C tick -> 400', noTcS.status === 400, noTcS.json?.error);
const sconf = await api(tokStaffA, 'POST', `/assist/orders/${apo.id}/confirm`, { tc_accepted: true });
ok('staff confirm places through the engine on the client\'s account',
  sconf.status === 200 && sconf.json.status === 'placed' && !!sconf.json.crm_order_id, `crm_order=${sconf.json?.crm_order_id}`);
ok('the placed row carries the staff attribution', sconf.json?.staff_user_id === STAFF_UID && sconf.json?.staff_name === 'Test Staff');
ok('the client still owns the order (open on A\'s account)',
  (await api(tokA, 'GET', '/orders')).json.some((o: any) => o.id === apo.id && o.status === 'placed'));
let amsgs = (await api(tokStaffA, 'GET', `/assist/conversations/${aconv.id}/messages`)).json;
ok('PLACED note names the staff member and the client\'s account',
  amsgs.some((m: any) => m.role === 'system' && /Test Staff confirmed .* PLACED on the market on the client's account as order #\d+/.test(m.content)),
  amsgs.filter((m: any) => m.role === 'system').map((m: any) => m.content).join(' | ').slice(0, 140));

// withdraw it again from the rail (no T&C needed)
const awd = await prepareWithdrawal(ctxA, sconf.json.crm_order_id, aconv.id, ON_BEHALF);
const awdConf = await api(tokStaffA, 'POST', `/assist/orders/${awd.id}/confirm`, {});
ok('staff withdrawal confirm succeeds', awdConf.status === 200 && awdConf.json.status === 'placed');
amsgs = (await api(tokStaffA, 'GET', `/assist/conversations/${aconv.id}/messages`)).json;
ok('WITHDRAWN note recorded in the assist chat', amsgs.some((m: any) => m.role === 'system' && /Test Staff confirmed .* WITHDRAWN/.test(m.content)));

// decline from the rail
const apo2 = await preparePendingOrder(ctxA, {
  side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9993, conversationId: aconv.id, onBehalf: ON_BEHALF,
});
const adec = await api(tokStaffA, 'POST', `/assist/orders/${apo2.id}/cancel`);
ok('staff decline works', adec.status === 200 && adec.json.status === 'cancelled');
amsgs = (await api(tokStaffA, 'GET', `/assist/conversations/${aconv.id}/messages`)).json;
ok('DECLINED note names the staff member', amsgs.some((m: any) => m.role === 'system' && /Test Staff DECLINED/.test(m.content)));

await api(tokStaffA, 'DELETE', `/assist/conversations/${aconv.id}`);

console.log(`\nbroker HTTP tests: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
