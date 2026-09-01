// Browser e2e for the brokerage confirm card: log in as a client, ask the advisor to set up
// a sell order, verify the confirmation card (T&C gate, confirm), and the system-note record.
//   node broker.js        (CRM :81 + sidecar :3100 must be running)
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const path = require('path');

const URL = process.env.WF_URL || 'http://localhost:81/';
const USER = process.env.WF_USER || 'stuart@hodgefarms.com.au';
const PASS = process.env.WF_PASS || 'blue49';
const UID = process.env.WF_UID || '119063';
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
  const ctx = await chromium.launchPersistentContext(path.join(process.cwd(), 'chrome-profile-broker'),
    { channel: 'chrome', headless: HEADLESS, viewport: { width: 1440, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  const frame = page.frameLocator('#content-iframe');
  const ta = () => frame.locator('.wfai-composer textarea');

  // ---- login + open the advisor ----
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginform input[name=username]', { timeout: 30000 });
  await page.fill('#loginform input[name=username]', USER);
  await page.fill('#loginform input[name=password]', PASS);
  await page.click('#loginbtn');
  await page.waitForURL('**/user-home.html', { timeout: 150000 }).catch(() => {});
  await page.waitForSelector('a[data-menu-id="ai-advisor"]', { timeout: 60000 });
  await page.click('a[data-menu-id="ai-advisor"]');
  await ta().waitFor({ timeout: 60000 });
  log('advisor open');

  // fresh conversation so pending orders from other runs don't interfere
  await frame.locator('.wfai-newchat').click().catch(() => {});

  // Send a message and wait for the FULL turn: streaming starts (stop icon), then ends with a
  // new assistant message. Waiting only for "not streaming" races the async send start.
  async function sendAndSettle(message) {
    const before = await frame.locator('.wfai-msg.assistant').count();
    await ta().click(); await ta().fill(message); await ta().press('Enter');
    await page.waitForFunction(() => {
      const f = document.querySelector('#content-iframe'); const d = f && f.contentDocument;
      return !!(d && d.querySelector('.wfai-send') && d.querySelector('.wfai-send').classList.contains('stop'));
    }, null, { timeout: 60000 });
    await page.waitForFunction((mc) => {
      const f = document.querySelector('#content-iframe'); const d = f && f.contentDocument; if (!d) return false;
      const send = d.querySelector('.wfai-send'); const a = d.querySelectorAll('.wfai-msg.assistant');
      return send && !send.classList.contains('stop') && a.length >= mc;
    }, before + 1, { timeout: 240000 });
    await page.waitForTimeout(1200); // let post-turn reloads (conversation + order cards) land
  }
  // The advisor legitimately queries an outlier price before preparing (fat-finger check),
  // so allow one confirming follow-up before requiring the card.
  async function askUntilCard(message, followup) {
    await sendAndSettle(message);
    if (await frame.locator('.wfai-order-card').count()) return;
    await sendAndSettle(followup);
    await frame.locator('.wfai-order-card').waitFor({ timeout: 30000 });
  }

  // ---- ask for a sell order ----
  await step('advisor turn produces a confirmation card', async () => {
    await askUntilCard(
      'Please set up a sell order for 1 ML of my Central Goulburn allocation at $9995 per megalitre. I understand the market context - go ahead and prepare it exactly as specified.',
      'Yes - $9,995/ML exactly, 1 ML. It is a deliberate above-market test order that should rest unmatched. Prepare it.');
  });
  await shot(page, '10-order-card.png');

  await step('card shows the order details', async () => {
    const txt = await frame.locator('.wfai-order-card').innerText();
    if (!/Sell 1 ML allocation/i.test(txt)) throw new Error('missing title: ' + txt.slice(0, 120));
    if (!/GOULBURN/i.test(txt)) throw new Error('missing region');
    if (!/9,?995/.test(txt)) throw new Error('missing price');
    if (!/REAL order/i.test(txt)) throw new Error('missing real-order warning');
  });

  await step('Confirm is disabled until T&C accepted', async () => {
    const disabled = await frame.locator('.wfai-order-card .confirm').isDisabled();
    if (!disabled) throw new Error('confirm enabled without T&C');
    await frame.locator('.wfai-order-card .tcbox').check();
    const enabled = !(await frame.locator('.wfai-order-card .confirm').isDisabled());
    if (!enabled) throw new Error('confirm still disabled after T&C');
  });

  let crmOrderId = null;
  await step('Confirm places the order through the engine', async () => {
    await frame.locator('.wfai-order-card .confirm').click();
    await frame.locator('.wfai-order-card .result .ok').waitFor({ timeout: 120000 });
    const txt = await frame.locator('.wfai-order-card .result .ok').innerText();
    const m = /#(\d+)/.exec(txt);
    if (!m) throw new Error('no order number in: ' + txt);
    crmOrderId = m[1];
    log('placed CRM order #' + crmOrderId);
  });
  await shot(page, '11-order-placed.png');

  await step('card clears and the system note records the placement', async () => {
    await frame.locator('.wfai-sysnote').first().waitFor({ timeout: 30000 });
    const note = await frame.locator('.wfai-sysnote').last().innerText();
    if (!note.includes(String(crmOrderId))) throw new Error('note lacks order id: ' + note);
    const cards = await frame.locator('.wfai-order-card').count();
    if (cards !== 0) throw new Error('card still present');
  });
  await shot(page, '12-system-note.png');

  // ---- decline path ----
  await step('a second proposal can be declined', async () => {
    await askUntilCard(
      'Prepare one more identical sell order: 1 ML Central Goulburn allocation at $9995/ML, same deliberate test price.',
      'Confirmed - same deliberate $9,995/ML test price. Prepare it.');
    await frame.locator('.wfai-order-card .decline').click();
    await page.waitForTimeout(1500);
    const cards = await frame.locator('.wfai-order-card').count();
    if (cards !== 0) throw new Error('card still present after decline');
    const note = await frame.locator('.wfai-sysnote').last().innerText();
    if (!/declined/i.test(note)) throw new Error('no declined note: ' + note);
  });
  await shot(page, '13-declined.png');

  // ---- forward order card (slice B) ----
  await step('forward request produces a card with the FORWARD banner + delivery date', async () => {
    await askUntilCard(
      'Set up a FORWARD sell: 1 ML of my Central Goulburn allocation at $9,995/ML for delivery on 01/03/2027. Deliberate above-market test price; I understand forwards rest until accepted. Prepare it.',
      'Yes - $9,995/ML exactly, delivery 01/03/2027, deliberate test order. Prepare it.');
    const txt = await frame.locator('.wfai-order-card').innerText();
    if (!/FORWARD Sell 1 ML allocation/i.test(txt)) throw new Error('missing FORWARD title: ' + txt.slice(0, 120));
    if (!/Delivery date/i.test(txt) || !txt.includes('01/03/2027')) throw new Error('missing delivery date row');
    if (!/rest/i.test(txt)) throw new Error('missing resting disclosure');
  });
  await shot(page, '14-forward-card.png');

  await step('forward card declined cleanly', async () => {
    await frame.locator('.wfai-order-card .decline').click();
    await page.waitForTimeout(1500);
    const cards = await frame.locator('.wfai-order-card').count();
    if (cards !== 0) throw new Error('forward card still present after decline');
  });

  // ---- cleanup: withdraw the resting order ----
  if (crmOrderId) {
    try {
      const out = execSync(`npx tsx src/scripts/withdraw-order.ts ${UID} ${crmOrderId}`,
        { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
      log('cleanup: ' + out.trim());
    } catch (e) { log('cleanup failed: ' + e.message); }
  }

  await ctx.close();
  log(`broker browser e2e: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
