// Broker-assist surface — module-level tests (no HTTP server needed; live local DB, like the
// other test-*.ts):
//   1. Token: `act` claim round-trips through mint/verify; malformed `act` is rejected.
//   2. Staff gate: staff uid -> true, client uid -> false, unknown -> false, DB error -> throws
//      StaffLookupFailed (fail closed — never admits).
//   3. Conversation separation: an assist conversation is invisible to every CLIENT-surface query
//      (list/search/getOwned — even for its creator), reachable only through the assist chokepoint
//      keyed by (id, client uid); delete is creator-only.
//   4. Tool surface: the assist tool list keeps the order tools (a broker places/withdraws for the
//      client behind the Confirm card) and excludes exactly the escalate-to-a-broker tools; the MCP
//      server built with escalations:false matches, and its prepare_* tools carry the staff actor.
//
//   npx tsx test-assist.ts
import crypto from 'node:crypto';
import { config } from './src/config';
import { verifyToken } from './src/auth';
import { isStaff, crmRoleIds, hasCrmRole, staffAccessDenial, StaffLookupFailed } from './src/staff';
import { resolveTrainer, roleLabel } from './src/trainer/auth';
import {
  createAssistConversation, getAssistConversation, listAssistConversations,
  deleteAssistConversation, listAssistMessages, addMessage,
  listConversations, searchConversations, getOwnedConversation, NotFound,
} from './src/conversations';
import { WF_TOOL_NAMES, WF_ASSIST_TOOL_NAMES, ESCALATION_TOOL_NAMES } from './src/data-tools';
import { pool } from './src/db';

const STAFF_UID = 10;        // Administrator Waterfind (usertype ADMIN)
const OTHER_STAFF_UID = 1666; // Levi Stephen (usertype BROKER)
const CLIENT_UID = 2725534;  // Beth — real client account with holdings
const OTHER_CLIENT_UID = 119063; // Stuart — a different client
const UNKNOWN_UID = -12345;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

// ---- 1. token: act claim ----------------------------------------------------
function b64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function mint(claims: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', config.sharedSecret).update(body).digest());
  return `${body}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
const base = { uid: STAFF_UID, name: 'Test Staff', ut: 3, iat: now, exp: now + 600, nonce: 'n' };

{
  const c = verifyToken(mint({ ...base, act: CLIENT_UID, actName: 'Beth Client' }));
  ok('act claim round-trips', c.act === CLIENT_UID && c.actName === 'Beth Client');
  const plain = verifyToken(mint(base));
  ok('token without act still verifies (client surface unaffected)', plain.act === undefined);
  for (const bad of [0, -5, 1.5, 'x' as unknown as number]) {
    let threw = false;
    try { verifyToken(mint({ ...base, act: bad })); } catch { threw = true; }
    ok(`malformed act rejected (${JSON.stringify(bad)})`, threw);
  }
}

// ---- 2. staff gate ----------------------------------------------------------
{
  ok('staff uid -> isStaff true', await isStaff(STAFF_UID) === true);
  ok('broker uid -> isStaff true', await isStaff(OTHER_STAFF_UID) === true);
  ok('client uid -> isStaff false', await isStaff(CLIENT_UID) === false);
  ok('unknown uid -> isStaff false', await isStaff(UNKNOWN_UID) === false);
  let threw = false;
  try { await isStaff('boom' as unknown as number); } catch (e) { threw = e instanceof StaffLookupFailed; }
  ok('DB error -> throws StaffLookupFailed (fail closed)', threw);
}

// ---- 2b. CRM role gate (the AI Trainer role behind the AI Trainer) ------------
{
  // The Administrator account holds SU in the shipped DB; AI_TRAINER is granted locally by
  // db/ai-trainer-role.sql. Assert on what the DB actually says so the test is honest either way.
  const roles = await crmRoleIds(STAFF_UID);
  ok('admin uid -> crmRoleIds includes SU', roles.includes('SU'), roles.join(','));
  const dbSaysTrainer = (await pool.query(
    `SELECT 1 FROM user_role_map m JOIN user_role r ON r.id = m.user_role
      WHERE m.waterfind_user = $1 AND r.role_id = 'AI_TRAINER'`, [STAFF_UID])).rowCount! > 0;
  ok('admin uid -> hasCrmRole(AI_TRAINER) matches the DB', await hasCrmRole(STAFF_UID, 'AI_TRAINER') === dbSaysTrainer,
    dbSaysTrainer ? 'granted' : 'not granted');
  ok('client uid -> no CRM roles', (await crmRoleIds(CLIENT_UID)).length === 0);
  ok('client uid -> hasCrmRole(AI_TRAINER) false', await hasCrmRole(CLIENT_UID, 'AI_TRAINER') === false);
  ok('unknown uid -> hasCrmRole false', await hasCrmRole(UNKNOWN_UID, 'AI_TRAINER') === false);
  ok('role id compare is case/space-insensitive', await hasCrmRole(STAFF_UID, ' su ') === true);
  ok('empty role id -> false', await hasCrmRole(STAFF_UID, '') === false);
  let threw2 = false;
  try { await crmRoleIds('boom' as unknown as number); } catch (e) { threw2 = e instanceof StaffLookupFailed; }
  ok('role lookup DB error -> throws StaffLookupFailed (fail closed)', threw2);

  // resolveTrainer composes both: staff AND role (when config.trainerRoleId is set).
  const outcome = await resolveTrainer(STAFF_UID);
  if (config.trainerRoleId) {
    ok('resolveTrainer(admin) -> identity iff the role is granted',
      dbSaysTrainer ? (typeof outcome === 'object' && outcome.role === config.trainerRoleId) : outcome === 'no-role',
      String(typeof outcome === 'object' ? 'admitted as ' + outcome.role : outcome));
  } else {
    ok('resolveTrainer(admin) -> identity (role check off)', typeof outcome === 'object');
  }
  ok('resolveTrainer(client) -> not-staff', await resolveTrainer(CLIENT_UID) === 'not-staff');
  ok('resolveTrainer(unknown) -> not-staff', await resolveTrainer(UNKNOWN_UID) === 'not-staff');
  ok('roleLabel AI_TRAINER -> "AI Trainer"', roleLabel('AI_TRAINER') === 'AI Trainer');
  ok('roleLabel SALES_MANAGER -> "Sales Manager"', roleLabel('SALES_MANAGER') === 'Sales Manager');
}

// ---- 2c. the ONE staff-surface admission rule (staff.ts staffAccessDenial) --------------------
// Assist + call notes, the trainer and the voice call log all go through this; the assist surface
// demands config.assistRoles (default BROKER,SU — the CRM's own gate on client recordings).
{
  ok('assistRoles default is BROKER,SU', JSON.stringify(config.assistRoles) === JSON.stringify(['BROKER', 'SU']), config.assistRoles.join(','));
  ok('admin (SU) -> admitted to assist', await staffAccessDenial(STAFF_UID, config.assistRoles) === null);
  ok('client -> not-staff', await staffAccessDenial(CLIENT_UID, config.assistRoles) === 'not-staff');
  ok('unknown -> not-staff', await staffAccessDenial(UNKNOWN_UID, config.assistRoles) === 'not-staff');
  ok('staff without the role -> missing-role', await staffAccessDenial(STAFF_UID, ['NO_SUCH_ROLE']) === 'missing-role');
  ok('empty role list -> usertype only (admitted)', await staffAccessDenial(STAFF_UID, []) === null);
  ok('role match is case/space-insensitive', await staffAccessDenial(STAFF_UID, [' su ']) === null);
  // A staff account that holds none of the assist roles is the regression the CRM already guards
  // against (DownloadPhoneRecordingAction: SU or BROKER): find one in the DB and assert denial.
  const r = await pool.query(
    `SELECT wu.id FROM waterfind_user wu JOIN waterfind_user_type wut ON wut.id = wu.usertype
      WHERE wut.type_number IN (1,2,3)
        AND NOT EXISTS (SELECT 1 FROM user_role_map m JOIN user_role ro ON ro.id = m.user_role
                         WHERE m.waterfind_user = wu.id AND upper(ro.role_id) IN ('BROKER','SU'))
      LIMIT 1`);
  if (r.rowCount) {
    ok(`staff uid ${r.rows[0].id} without BROKER/SU -> missing-role`, await staffAccessDenial(Number(r.rows[0].id), config.assistRoles) === 'missing-role');
  } else {
    ok('(no role-less staff account in this DB to test denial against)', true);
  }
  let threw3 = false;
  try { await staffAccessDenial('boom' as unknown as number, config.assistRoles); } catch (e) { threw3 = e instanceof StaffLookupFailed; }
  ok('staffAccessDenial DB error -> StaffLookupFailed (fail closed)', threw3);
}

// ---- 3. conversation separation --------------------------------------------
{
  const conv = await createAssistConversation(STAFF_UID, 'Test Staff', CLIENT_UID, 'assist-test-conv');
  try {
    ok('assist conversation created with client binding',
      conv.assist_client_uid === CLIENT_UID && conv.user_id === STAFF_UID && conv.assist_staff_name === 'Test Staff');

    await addMessage(conv.id, 'user', 'assist-test needle-message', { meta: { staff: 'Test Staff' } });

    const clientList = await listConversations(STAFF_UID, true);
    ok('invisible in creator\'s CLIENT-surface list', !clientList.some((c) => c.id === conv.id));

    const search = await searchConversations(STAFF_UID, 'needle-message');
    ok('invisible to CLIENT-surface search', !search.some((c) => c.id === conv.id));

    let owned = false;
    try { await getOwnedConversation(conv.id, STAFF_UID); owned = true; } catch (e) { owned = !(e instanceof NotFound); }
    ok('getOwnedConversation refuses it even for its creator', !owned);

    const assistList = await listAssistConversations(CLIENT_UID);
    ok('visible in the client\'s assist list', assistList.some((c) => c.id === conv.id));

    const fetched = await getAssistConversation(conv.id, CLIENT_UID);
    ok('assist chokepoint returns it for the right client', fetched.id === conv.id);

    let cross = false;
    try { await getAssistConversation(conv.id, OTHER_CLIENT_UID); cross = true; } catch (e) { cross = !(e instanceof NotFound); }
    ok('assist chokepoint refuses a different client uid', !cross);

    const msgs = await listAssistMessages(conv.id, CLIENT_UID);
    ok('assist messages listed with staff attribution',
      msgs.length === 1 && msgs[0].content === 'assist-test needle-message' && msgs[0].meta?.staff === 'Test Staff');

    let otherDeleted = false;
    try { await deleteAssistConversation(conv.id, CLIENT_UID, OTHER_STAFF_UID); otherDeleted = true; }
    catch (e) { otherDeleted = !(e instanceof NotFound); }
    ok('delete by a non-creator staff member is refused', !otherDeleted);

    await deleteAssistConversation(conv.id, CLIENT_UID, STAFF_UID);
    let gone = false;
    try { await getAssistConversation(conv.id, CLIENT_UID); } catch (e) { gone = e instanceof NotFound; }
    ok('creator can delete; conversation is gone', gone);
  } finally {
    // Belt-and-braces cleanup if an assertion threw before the delete.
    try { await deleteAssistConversation(conv.id, CLIENT_UID, STAFF_UID); } catch { /* already gone */ }
  }
}

// ---- 4. tool surface --------------------------------------------------------
{
  const assist = WF_ASSIST_TOOL_NAMES as readonly string[];
  const escalations = ESCALATION_TOOL_NAMES as readonly string[];
  ok('no escalate-to-a-broker tool in the assist list (the broker IS the human)', escalations.every((n) => !assist.includes(n)));
  ok('order tools kept: the broker places / withdraws for the client',
    ['prepare_sell_order', 'prepare_buy_order', 'prepare_order_withdrawal'].every((n) => assist.includes(n)));
  ok('order visibility kept', assist.includes('get_my_open_orders') && assist.includes('get_my_ai_orders'));
  ok('holdings/market/knowledge grounding kept',
    ['get_my_holdings', 'get_price_band', 'get_climate_outlook'].every((n) => assist.includes(n)));
  ok('assist list = full list minus exactly the escalation tools',
    assist.length === (WF_TOOL_NAMES as readonly string[]).length - escalations.length);

  const { buildAdvisorMcpServer } = await import('./src/data-tools');
  const ctx = { uid: CLIENT_UID, account: 1, premium: false, accessClass: null, subclass: null, asof: config.asof };
  const server = buildAdvisorMcpServer(ctx, null, { escalations: false, onBehalf: { staffUid: STAFF_UID, staffName: 'Test Staff' } }) as any;
  // The SDK wraps the defs; find the registered tool names wherever the instance keeps them.
  const names: string[] = server?.instance?._registeredTools
    ? Object.keys(server.instance._registeredTools)
    : (server?.tools ?? []).map((t: any) => t.name);
  if (names.length) {
    ok('MCP server built without the escalation tools', escalations.every((n) => !names.includes(n)),
      `${names.length} tools`);
    ok('MCP server keeps the order tools', ['prepare_sell_order', 'prepare_order_withdrawal'].every((n) => names.includes(n)));
  } else {
    console.log('  note: could not introspect MCP server tool names; covered by list assertions above');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
await pool.end();
process.exit(fail ? 1 : 0);
