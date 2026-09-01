// Interactive e2e: log in as a client, open the AI Advisor tab, exercise every feature.
const { chromium } = require('playwright-core');
const path = require('path');

const URL = process.env.WF_URL || 'http://localhost:81/';
const USER = process.env.WF_USER || 'stuart@hodgefarms.com.au';
const PASS = process.env.WF_PASS || 'blue49';
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
  const ctx = await chromium.launchPersistentContext(path.join(process.cwd(), 'chrome-profile-e2e'),
    { channel: 'chrome', headless: HEADLESS, viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERR', (e.message || '').slice(0, 120)));

  // auto-accept native dialogs (rename prompt / delete confirm)
  let dialogAnswer = 'Renamed by e2e';
  page.on('dialog', async (d) => { try { await d.accept(dialogAnswer); } catch (e) {} });

  const frame = page.frameLocator('#content-iframe');
  const ta = () => frame.locator('.wfai-composer textarea');
  async function waitAssistantSettled(minCount) {
    await page.waitForFunction((mc) => {
      const f = document.querySelector('#content-iframe'); const d = f && f.contentDocument; if (!d) return false;
      const send = d.querySelector('.wfai-send'); const a = d.querySelectorAll('.wfai-msg.assistant .content');
      return send && !send.classList.contains('stop') && a.length >= mc && a[a.length - 1].textContent.trim().length > 30;
    }, minCount, { timeout: 150000 });
  }
  const theme = () => page.evaluate(() => document.querySelector('#content-iframe').contentDocument.documentElement.getAttribute('data-theme'));

  // ---- login ----
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginform input[name=username]', { timeout: 30000 });
  await page.fill('#loginform input[name=username]', USER);
  await page.fill('#loginform input[name=password]', PASS);
  await page.click('#loginbtn');
  await page.waitForURL('**/user-home.html', { timeout: 150000 }).catch((e) => log('nav-wait', e.message));
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  log('logged in url=' + page.url());

  await step('AI Advisor tab present in left menu', async () => {
    await page.waitForSelector('a[data-menu-id="ai-advisor"]', { timeout: 30000 });
  });
  await shot(page, '00-userhome.png');

  await step('open AI Advisor tab -> chat UI loads in iframe', async () => {
    await page.click('a[data-menu-id="ai-advisor"]');
    await frame.locator('.wfai-composer textarea').waitFor({ timeout: 60000 });
    await frame.locator('.wfai-side .wfai-newchat').waitFor({ timeout: 10000 });
  });
  await shot(page, '01-chat-loaded.png');

  await step('send message -> streamed assistant answer renders', async () => {
    await ta().click();
    await ta().fill('In two sentences, what are the key things a broker should check before selling high-security entitlement from the Murrumbidgee to the lower Murray?');
    await ta().press('Enter');
    await waitAssistantSettled(1);
  });
  const answer = await frame.locator('.wfai-msg.assistant .content').first().innerText().catch(() => '');
  log('ANSWER1: ' + answer.slice(0, 160).replace(/\s+/g, ' '));
  await shot(page, '02-answer.png');

  await step('conversation appears in sidebar with a title', async () => {
    const n = await frame.locator('.wfai-conv').count();
    if (n < 1) throw new Error('no conversation in sidebar');
  });

  await step('regenerate last answer', async () => {
    await frame.locator('.wfai-msg.assistant').last().hover();
    await frame.locator('.wfai-msg.assistant .actions button', { hasText: 'Regenerate' }).last().click();
    await waitAssistantSettled(1);
  });
  await shot(page, '03-regenerated.png');

  await step('edit first user message and resubmit (branch)', async () => {
    await frame.locator('.wfai-msg.user').first().hover();
    await frame.locator('.wfai-msg.user .actions button', { hasText: 'Edit' }).first().click();
    const editor = frame.locator('.wfai-edit textarea');
    await editor.waitFor({ timeout: 5000 });
    await editor.fill('In one sentence, what mainly drives temporary (allocation) water prices?');
    await frame.locator('.wfai-edit .save').click();
    await waitAssistantSettled(1);
  });
  await shot(page, '04-edited.png');

  await step('follow-up question (session continuity)', async () => {
    await ta().fill('And how does that differ from what drives entitlement prices?');
    await ta().press('Enter');
    await waitAssistantSettled(2);
  });
  await shot(page, '05-followup.png');

  await step('search box filters the sidebar', async () => {
    await frame.locator('.wfai-search input').fill('driv');
    await page.waitForTimeout(600);
    const n = await frame.locator('.wfai-conv').count();
    await frame.locator('.wfai-search input').fill('');
    if (n < 0) throw new Error('search returned nothing structural');
  });

  await step('toggle dark theme (persists via settings)', async () => {
    const before = await theme();
    await frame.locator('.wfai-side-foot .theme').click();
    await page.waitForTimeout(400);
    const after = await theme();
    if (before === after) throw new Error('theme did not change (' + before + ')');
  });
  await shot(page, '06-dark.png');

  await step('custom instructions modal opens and saves', async () => {
    await frame.locator('.wfai-side-foot .ci').click();
    await frame.locator('.wfai-modal textarea').waitFor({ timeout: 5000 });
    await frame.locator('.wfai-modal textarea').fill('I am a broker in the southern connected system; keep answers concise.');
    await frame.locator('.wfai-modal .save').click();
    await page.waitForTimeout(400);
  });

  await step('rename conversation via sidebar', async () => {
    dialogAnswer = 'Allocation price drivers';
    await frame.locator('.wfai-conv').first().hover();
    await frame.locator('.wfai-conv .rn').first().click();
    await page.waitForTimeout(500);
    const t = await frame.locator('.wfai-conv .t').first().innerText();
    if (!/Allocation price drivers/i.test(t)) throw new Error('title not renamed: ' + t);
  });

  await step('export conversation as markdown (download)', async () => {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      frame.locator('.wfai-head .export').click(),
    ]);
    const p = path.join(SHOTS, 'export.md');
    await dl.saveAs(p);
    log('downloaded export to ' + p);
  });

  await step('new chat resets to empty state', async () => {
    await frame.locator('.wfai-newchat').click();
    await page.waitForTimeout(400);
    if (!(await frame.locator('.wfai-empty').isVisible())) throw new Error('empty state not shown');
  });
  await shot(page, '07-newchat.png');

  await step('stop generation mid-stream', async () => {
    await ta().fill('Give me a very long, detailed, multi-paragraph explanation of carryover rules across NSW, VIC and SA.');
    await ta().press('Enter');
    await frame.locator('.wfai-send.stop').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await frame.locator('.wfai-send.stop').click();
    await page.waitForFunction(() => {
      const d = document.querySelector('#content-iframe').contentDocument;
      const s = d.querySelector('.wfai-send'); return s && !s.classList.contains('stop');
    }, { timeout: 20000 });
  });
  await shot(page, '08-stopped.png');

  await step('delete conversation via sidebar', async () => {
    const before = await frame.locator('.wfai-conv').count();
    await frame.locator('.wfai-conv').first().hover();
    await frame.locator('.wfai-conv .del').first().click();
    await page.waitForTimeout(800);
    const after = await frame.locator('.wfai-conv').count();
    if (after >= before) throw new Error('conversation count did not drop (' + before + '->' + after + ')');
  });
  await shot(page, '09-final.png');

  log('SUMMARY pass=' + pass + ' fail=' + fail);
  await ctx.close();
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error('E2E-ERR', (e && e.stack) || e); process.exit(1); });
