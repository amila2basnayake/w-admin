// Browser e2e for call-note prefill in the CRM's Add Comment popup:
//   admin logs in -> opens Beth's record -> opens Add Comment (the page's own openAddComment) ->
//   the popup's textarea fills with the drafted note for the just-ended logged call (recording
//   served by the FAKE PBX), the character counter updates, the "Check:" line shows anything to
//   double-check -> a second popup opened after typing is NOT overwritten -> nothing is saved.
// Prereqs: CRM :81, sidecar :3100 (AIADVISOR_PBX_SOURCE=env -> fake PBX), fake PBX on :7866
// serving test/fixtures/calls (npm run callnotes:fixtures; npm run callnotes:fake-pbx), the
// prefill script deployed (node crm-seam/deploy-client-rail.mjs), and a seeded just-ended call on
// Beth's account (registry_user 2725535) by the logged-in staff user (admin = 10) whose
// phonecall_id names a fixture — psql -U waterfind -d waterfind-db:
//   DELETE FROM ai_advisor.call_note WHERE phonecall_id = 'temp-sell-negotiation.stereo';
//   DELETE FROM public.contact WHERE id = 999900000401;
//   INSERT INTO public.contact (id, registry_user, date_edited, note, added_by, subclass, client_service,
//     phone_record, phonecall_id, call_duration_seconds, incoming_phone_call, phone_number)
//   VALUES (999900000401, 2725535, (now() AT TIME ZONE 'Australia/Adelaide') - interval '4 minutes',
//     'Incoming Phone Call ', 10, 'C', false, true, 'temp-sell-negotiation.stereo', 80, true, '0400000099');
// (and remove both rows afterwards). The worker pre-drafts it within a minute; opening the popup
// sooner shows the "Drafting from your call..." placeholder until it lands.
//   WF_PASS=<admin password> node call-notes.js        (WF_HEADLESS=0 to watch)
const { chromium } = require('playwright-core');
const path = require('path');

const URL = process.env.WF_URL || 'http://localhost:81/';
const USER = process.env.WF_USER || 'admin';
const PASS = process.env.WF_PASS;   // env only — never a default in source
if (!PASS) { console.error('WF_PASS is not set (the CRM login password for WF_USER)'); process.exit(2); }
const CLIENT_UID = process.env.WF_CLIENT || '2725534';
const REG_USER = process.env.WF_REGUSER || '2725535';
const SHOTS = process.env.SHOTS || process.cwd();
const HEADLESS = process.env.WF_HEADLESS !== '0';
const KEEP = process.env.WF_KEEP === '1';   // headed + leave the client page and the filled popup open for review (skips the typing-first case)

let pass = 0, fail = 0;
function log(...a) { console.log('E2E', ...a); }
async function step(name, fn) {
  try { await fn(); pass++; log('PASS  ' + name); }
  catch (e) { fail++; log('FAIL  ' + name + '  -> ' + (e.message || e)); }
}
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n) }).catch(() => {});

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(process.cwd(), 'chrome-profile-callnotes'),
    { channel: 'chrome', headless: HEADLESS && !KEEP, viewport: { width: 1600, height: 950 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => { if (!/GWT|\$\.|jQuery/.test(String(e.message))) log('PAGEERR', e.message); });

  // ---- login ----
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginform input[name=username]', { timeout: 30000 });
  await page.fill('#loginform input[name=username]', USER);
  await page.fill('#loginform input[name=password]', PASS);
  await page.click('#loginbtn');
  await page.waitForURL('**/user-home.html', { timeout: 150000 }).catch(() => {});
  log('logged in');

  // ---- client page ----
  await page.goto(URL.replace(/\/$/, '') + '/admin-view-user-details.html?userId=' + CLIENT_UID, { waitUntil: 'domcontentloaded' });
  await step("client page has the CRM's openAddComment", async () => {
    await page.waitForFunction(() => typeof window.openAddComment === 'function', null, { timeout: 90000 });
  });

  // ---- open Add Comment the way the page does ----
  const openPopup = async () => {
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 30000 }),
      page.evaluate((id) => window.openAddComment(id), REG_USER),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForSelector('#note', { timeout: 90000 });
    popup.on('pageerror', (e) => log('POPUPERR', e.message));
    return popup;
  };
  let popup = await openPopup();
  let text = '';
  await step('popup textarea fills with the drafted note (within 90 s)', async () => {
    await popup.waitForFunction(() => (document.getElementById('note').value || '').trim().length > 20, null, { timeout: 95000 });
    text = await popup.$eval('#note', (el) => el.value);
    log('note:', text);
    if (!/200\s*ML/i.test(text) || !/295/.test(text)) throw new Error('note does not carry the call facts (200ML / $295)');
    if (/[^\x00-\x7F]/.test(text)) throw new Error('non-ASCII in the note');
  });
  await step('character counter reflects the prefilled text', async () => {
    const n = await popup.$eval('#myCounter', (el) => parseInt(el.textContent, 10));
    if (!(n > 20)) throw new Error('counter = ' + n);
  });
  await step('nothing is marked as AI in the textarea; checks (if any) sit under it', async () => {
    if (/AI call note|Drafted by/i.test(text)) throw new Error('marker text in the note');
    const chk = await popup.$$eval('div', (ds) => ds.map((d) => d.textContent.trim()).filter((t) => t.startsWith('Check:')));
    log('checks:', chk.length ? chk[0] : '(none)');
  });
  await step('placeholder cleared once filled', async () => {
    const ph = await popup.$eval('#note', (el) => el.getAttribute('placeholder'));
    if (ph) throw new Error('placeholder still set: ' + ph);
  });
  await shot(popup, '43-comment-popup.png');
  if (KEEP) {
    log(`\n${pass} passed, ${fail} failed — left open for review (Ctrl+C to end)`);
    await new Promise(() => {});
  }
  await popup.close();

  // ---- a popup where the broker starts typing is never overwritten ----
  popup = await openPopup();
  await step('typing first wins: the prefill never overwrites', async () => {
    await popup.fill('#note', 'My own words.');
    await popup.waitForTimeout(6000);
    const v = await popup.$eval('#note', (el) => el.value);
    if (v !== 'My own words.') throw new Error('overwritten: ' + v.slice(0, 60));
  });
  await popup.close();

  await shot(page, '44-client-page.png');
  log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
