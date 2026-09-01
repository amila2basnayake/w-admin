// Browser e2e for brokerage on the Client Rail: a BROKER logs in, opens a client's CRM page,
// opens the rail, asks the advisor to set up a sell order for the client, confirms it on the rail's
// card (client-instructed / T&C tick), sees the placement note name the broker and the client's
// account, then withdraws the same order through the rail and declines a further proposal.
//   node assist-orders.js        (CRM :81 + sidecar :3100 must be running; WF_HEADLESS=0 to watch)
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const path = require('path');

const URL = process.env.WF_URL || 'http://localhost:81/';
const USER = process.env.WF_USER || 'nick.sayer@waterfind.com.au';   // a BROKER (usertype 603)
const PASS = process.env.WF_PASS || 'blue49';
const CLIENT_UID = process.env.WF_CLIENT || '119063';                 // Stuart (Central Goulburn holding)
const SHOTS = process.env.SHOTS || process.cwd();
const HEADLESS = process.env.WF_HEADLESS !== '0';

let pass = 0, fail = 0;
function log(...a) { console.log('E2E', ...a); }
async function step(name, fn) {
  try { await fn(); pass++; log('PASS  ' + name); }
  catch (e) { fail++; log('FAIL  ' + name + '  -> ' + (e.message || e)); }
}
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n) }).catch(() => {});

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(process.cwd(), 'chrome-profile-assist'),
    { channel: 'chrome', headless: HEADLESS, viewport: { width: 1600, height: 950 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => { if (!/GWT|\$\.|jQuery/.test(String(e.message))) log('PAGEERR', e.message); });
  const frame = page.frameLocator('#wfai-rail iframe');
  const ta = () => frame.locator('.wfaic-composer textarea');

  // ---- login as the broker, open the client's page, open the rail ----
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginform input[name=username]', { timeout: 30000 });
  await page.fill('#loginform input[name=username]', USER);
  await page.fill('#loginform input[name=password]', PASS);
  await page.click('#loginbtn');
  await page.waitForURL('**/user-home.html', { timeout: 150000 }).catch(() => {});
  log('logged in as ' + USER);
  await page.goto(URL.replace(/\/$/, '') + '/admin-view-user-details.html?userId=' + CLIENT_UID, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#wfai-tab', { timeout: 120000 });
  await page.click('#wfai-tab');
  await ta().waitFor({ timeout: 90000 });
  await frame.locator('.newchat').click().catch(() => {});   // fresh chat: no cards from other runs
  log('rail open');

  // Wait for the FULL turn: streaming starts (stop icon), then ends with a new assistant message.
  async function sendAndSettle(message) {
    const before = await frame.locator('.wfaic-msg.assistant').count();
    await ta().click(); await ta().fill(message); await ta().press('Enter');
    await page.waitForFunction(() => {
      const f = document.querySelector('#wfai-rail iframe'); const d = f && f.contentDocument;
      const s = d && d.querySelector('.wfaic-composer .send');
      return !!(s && s.classList.contains('stop'));
    }, null, { timeout: 60000 });
    await page.waitForFunction((mc) => {
      const f = document.querySelector('#wfai-rail iframe'); const d = f && f.contentDocument; if (!d) return false;
      const s = d.querySelector('.wfaic-composer .send'); const a = d.querySelectorAll('.wfaic-msg.assistant');
      return s && !s.classList.contains('stop') && a.length >= mc;
    }, before + 1, { timeout: 240000 });
    await page.waitForTimeout(1500); // post-turn reloads (order cards) land
  }
  // The advisor may query an outlier price before preparing; allow one confirming follow-up.
  async function askUntilCard(message, followup) {
    await sendAndSettle(message);
    if (await frame.locator('.wfai-order-card').count()) return;
    await sendAndSettle(followup);
    await frame.locator('.wfai-order-card').waitFor({ timeout: 30000 });
  }

  // ---- sell order for the client ----
  await step('advisor turn on the rail produces a confirmation card', async () => {
    await askUntilCard(
      "Stuart has instructed me to sell 1 ML of his Central Goulburn allocation at $9,995 per megalitre. It's a deliberate above-market order that should rest unmatched - prepare it exactly as specified.",
      'Yes - $9,995/ML exactly, 1 ML, deliberate test order on his instruction. Prepare it.');
  });
  await shot(page, '50-rail-order-card.png');

  await step('card is addressed to the broker, about the client', async () => {
    const txt = await frame.locator('.wfai-order-card').innerText();
    if (!/Sell 1 ML allocation for /i.test(txt)) throw new Error('missing title: ' + txt.slice(0, 120));
    if (!/GOULBURN/i.test(txt)) throw new Error('missing region');
    if (!/9,?995/.test(txt)) throw new Error('missing price');
    if (!/has instructed this order/i.test(txt)) throw new Error('missing client-instructed tick');
    if (!/REAL order on .*account/i.test(txt)) throw new Error('missing real-order warning');
    if (!/placed by you/i.test(txt)) throw new Error('missing attribution line');
  });

  await step('card fits the 400px rail (no horizontal overflow)', async () => {
    const over = await page.evaluate(() => {
      const f = document.querySelector('#wfai-rail iframe'); const d = f.contentDocument;
      const c = d.querySelector('.wfai-order-card');
      return c ? c.scrollWidth - c.clientWidth : -1;
    });
    if (over > 1) throw new Error('card overflows by ' + over + 'px');
  });

  await step('Confirm is disabled until the client-instructed / T&C tick', async () => {
    if (!(await frame.locator('.wfai-order-card .confirm').isDisabled())) throw new Error('confirm enabled without the tick');
    await frame.locator('.wfai-order-card .tcbox').check();
    if (await frame.locator('.wfai-order-card .confirm').isDisabled()) throw new Error('confirm still disabled after the tick');
  });

  let crmOrderId = null;
  await step('Confirm places the order on the client\'s account', async () => {
    await frame.locator('.wfai-order-card .confirm').click();
    await frame.locator('.wfai-order-card .result .ok').waitFor({ timeout: 120000 });
    const txt = await frame.locator('.wfai-order-card .result .ok').innerText();
    const m = /#(\d+)/.exec(txt);
    if (!m) throw new Error('no order number in: ' + txt);
    crmOrderId = m[1];
    log('placed CRM order #' + crmOrderId);
  });
  await shot(page, '51-rail-order-placed.png');

  await step('card clears; the note names the broker and the client\'s account', async () => {
    await frame.locator('.wfai-sysnote').first().waitFor({ timeout: 30000 });
    const note = await frame.locator('.wfai-sysnote').last().innerText();
    if (!note.includes(String(crmOrderId))) throw new Error('note lacks order id: ' + note);
    if (/The user confirmed/.test(note)) throw new Error('note attributes the click to "the user": ' + note);
    if (!/confirmed and .* PLACED on the market on the client's account/.test(note)) throw new Error('unexpected note: ' + note);
    if (await frame.locator('.wfai-order-card').count()) throw new Error('card still present');
  });

  // ---- withdraw it again through the rail ----
  let withdrawn = false;
  await step('withdrawal request produces a withdraw card', async () => {
    await askUntilCard(
      'Stuart now wants that order withdrawn - withdraw order #' + crmOrderId + ' for him.',
      'Yes, withdraw order #' + crmOrderId + '. Prepare the withdrawal.');
    const txt = await frame.locator('.wfai-order-card').innerText();
    if (!new RegExp('Withdraw .*order #' + crmOrderId).test(txt)) throw new Error('unexpected card: ' + txt.slice(0, 120));
  });
  await step('withdrawal confirms without a T&C tick and is recorded', async () => {
    if (await frame.locator('.wfai-order-card .confirm').isDisabled()) throw new Error('withdraw confirm should be enabled');
    await frame.locator('.wfai-order-card .confirm').click();
    await frame.locator('.wfai-order-card .result .ok').waitFor({ timeout: 120000 });
    await page.waitForTimeout(2500);
    const note = await frame.locator('.wfai-sysnote').last().innerText();
    if (!/WITHDRAWN/.test(note)) throw new Error('no withdrawn note: ' + note);
    withdrawn = true;
  });
  await shot(page, '52-rail-withdrawn.png');

  // ---- decline path ----
  await step('a further proposal can be declined from the rail', async () => {
    await askUntilCard(
      'Prepare one more identical sell for Stuart: 1 ML Central Goulburn allocation at $9,995/ML, same deliberate test price, on his instruction.',
      'Confirmed - same deliberate $9,995/ML test price, on his instruction. Prepare it.');
    await frame.locator('.wfai-order-card .decline').click();
    await page.waitForTimeout(2000);
    if (await frame.locator('.wfai-order-card').count()) throw new Error('card still present after decline');
    const note = await frame.locator('.wfai-sysnote').last().innerText();
    if (!/DECLINED/.test(note)) throw new Error('no declined note: ' + note);
  });
  await shot(page, '53-rail-declined.png');

  // ---- cleanup: if the rail withdrawal did not happen, withdraw the resting order directly ----
  if (crmOrderId && !withdrawn) {
    try {
      const out = execSync(`npx tsx src/scripts/withdraw-order.ts ${CLIENT_UID} ${crmOrderId}`,
        { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
      log('cleanup: ' + out.trim());
    } catch (e) { log('cleanup failed: ' + e.message); }
  }

  await ctx.close();
  log(`assist-orders browser e2e: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
