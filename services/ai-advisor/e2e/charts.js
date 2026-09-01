// Browser e2e for the chart/table presentation feature: seed a message containing a
// ```chart block + markdown table (deterministic render check), then one live advisor turn
// asking for a trajectory chart (proves the PRESENTATION_HINT produces a valid spec).
//   node charts.js        (CRM :81 + sidecar :3100 must be running)
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const path = require('path');

const URL = process.env.WF_URL || 'http://localhost:81/';
const USER = process.env.WF_USER || 'stuart@hodgefarms.com.au';
const PASS = process.env.WF_PASS || 'blue49';
const UID = process.env.WF_UID || '119063';
const SHOTS = process.env.SHOTS || process.cwd();
const HEADLESS = process.env.WF_HEADLESS !== '0';
const PSQL = process.env.WF_PSQL || 'C:/Programs/PostgreSQL/9.6/bin/psql.exe';

let pass = 0, fail = 0;
function log(...a) { console.log('E2E', ...a); }
async function step(name, fn) {
  try { await fn(); pass++; log('PASS  ' + name); }
  catch (e) { fail++; log('FAIL  ' + name + '  -> ' + (e.message || e)); }
}
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n) }).catch(() => {});

function psql(sql) {
  return execSync(`"${PSQL}" -U waterfind -h localhost -p 5432 -d waterfind-db -tAq -v ON_ERROR_STOP=1`,
    { input: sql, env: { ...process.env, PGPASSWORD: 'password' } }).toString().trim();
}

// Seeded assistant content: one line chart with a band, one bar chart, one markdown table.
const SEED_CONTENT = [
  'Here is the render test.',
  '',
  '```chart',
  '{"type":"line","title":"Seeded line chart","unit":"$/ML",',
  ' "x":["Jan","Feb","Mar","Apr","May","Jun"],',
  ' "series":[{"name":"Median","data":[62,58,55,49,47,44]},{"name":"Best bid","data":[58,54,52,47,44,41]}],',
  ' "band":{"name":"Min-max","low":[48,44,41,38,36,33],"high":[75,70,66,61,58,55]}}',
  '```',
  '',
  '```chart',
  '{"type":"bar","title":"Seeded bar chart","unit":"ML",',
  ' "x":["Goulburn","Murray","Loddon"],',
  ' "series":[{"name":"Held","data":[15.8,0,3.2]}]}',
  '```',
  '',
  '| Region | Product | Volume (ML) | Price ($/ML) |',
  '| --- | --- | ---: | ---: |',
  '| Central Goulburn 1A | allocation | 15.8 | 47 |',
  '| Loddon | allocation | 3.2 | 39 |',
  '',
  'And a closing paragraph.',
].join('\n');

(async () => {
  // ---- seed a conversation with a known chart/table message ----
  psql(`DELETE FROM ai_advisor.conversation WHERE title = 'Chart render test'`); // stale runs
  const convId = psql(`INSERT INTO ai_advisor.conversation (user_id, title) VALUES (${UID}, 'Chart render test') RETURNING id`).split('\n')[0].trim();
  if (!/^\d+$/.test(convId)) throw new Error('seed failed: ' + convId);
  psql(`INSERT INTO ai_advisor.message (conversation_id, role, content) VALUES (${convId}, 'user', 'Show me the render test')`);
  psql(`INSERT INTO ai_advisor.message (conversation_id, role, content) VALUES (${convId}, 'assistant', '${SEED_CONTENT.replace(/'/g, "''")}')`);
  log('seeded conversation', convId);

  const ctx = await chromium.launchPersistentContext(path.join(process.cwd(), 'chrome-profile-charts'),
    { channel: 'chrome', headless: HEADLESS, viewport: { width: 1440, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  const frame = page.frameLocator('#content-iframe');
  const ta = () => frame.locator('.wfai-composer textarea');

  // ---- login + open the advisor ----
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginform input[name=username], a[data-menu-id="ai-advisor"]', { timeout: 60000 });
  if (await page.locator('#loginform input[name=username]').count()) {
    await page.fill('#loginform input[name=username]', USER);
    await page.fill('#loginform input[name=password]', PASS);
    await page.click('#loginbtn');
    await page.waitForURL('**/user-home.html', { timeout: 150000 }).catch(() => {});
  }
  await page.waitForSelector('a[data-menu-id="ai-advisor"]', { timeout: 60000 });
  await page.click('a[data-menu-id="ai-advisor"]');
  await ta().waitFor({ timeout: 60000 });
  log('advisor open');

  // ---- deterministic render checks on the seeded conversation ----
  await frame.locator('.wfai-conv .t', { hasText: 'Chart render test' }).first().click();
  await frame.locator('.wfai-chart').first().waitFor({ timeout: 15000 });

  await step('two charts hydrate to SVG', async () => {
    const n = await frame.locator('.wfai-chart.done svg').count();
    if (n !== 2) throw new Error('expected 2 hydrated chart SVGs, got ' + n);
  });

  await step('line chart draws series paths + band + legend', async () => {
    const chart = frame.locator('.wfai-chart.done').first();
    if (await chart.locator('svg path.ln').count() < 2) throw new Error('missing line paths');
    if (await chart.locator('svg path.band').count() !== 1) throw new Error('missing band');
    const legend = await chart.locator('.legend').innerText().catch(() => '');
    if (!/Median/.test(legend) || !/Best bid/.test(legend)) throw new Error('legend missing series: ' + legend);
  });

  await step('bar chart draws bars', async () => {
    const chart = frame.locator('.wfai-chart.done').nth(1);
    if (await chart.locator('svg path.bar').count() < 3) throw new Error('missing bars');
  });

  await step('table toggle shows a data table', async () => {
    const chart = frame.locator('.wfai-chart.done').first();
    await chart.locator('button.tbl').click();
    const t = await chart.locator('.wfai-tablewrap table').innerText({ timeout: 5000 });
    if (!/Median/.test(t) || !/62/.test(t)) throw new Error('table missing data: ' + t.slice(0, 120));
    await chart.locator('button.tbl').click(); // second click hides the table again
    if (await chart.locator('.wfai-tablewrap').isVisible()) throw new Error('table not hidden after second toggle');
  });

  await step('markdown table renders as a real table', async () => {
    const t = frame.locator('.wfai-msg.assistant .content table').last();
    const txt = await t.innerText();
    if (!/Central Goulburn 1A/.test(txt) || !/15\.8/.test(txt)) throw new Error('markdown table wrong: ' + txt.slice(0, 120));
  });
  await shot(page, '20-seeded-charts.png');

  // ---- live turn: the model should answer with a chart block that renders ----
  await frame.locator('.wfai-newchat').click();
  await step('live advisor turn renders a chart', async () => {
    await ta().click();
    await ta().fill('Chart the announced seasonal allocation percentage trajectory for the 1A Central Goulburn HIGH reliability zone over the last 12 months. A chart please, with a one-line takeaway.');
    await ta().press('Enter');
    await page.waitForFunction(() => {
      const f = document.querySelector('#content-iframe'); const d = f && f.contentDocument;
      return !!(d && d.querySelector('.wfai-send') && d.querySelector('.wfai-send').classList.contains('stop'));
    }, null, { timeout: 60000 });
    await page.waitForFunction(() => {
      const f = document.querySelector('#content-iframe'); const d = f && f.contentDocument; if (!d) return false;
      const send = d.querySelector('.wfai-send');
      return send && !send.classList.contains('stop');
    }, null, { timeout: 300000 });
    await page.waitForTimeout(1500);
    const n = await frame.locator('.wfai-chart.done svg').count();
    if (n < 1) {
      const body = await frame.locator('.wfai-msg.assistant .content').last().innerText().catch(() => '');
      throw new Error('no rendered chart in live reply; content: ' + body.slice(0, 200));
    }
  });
  await shot(page, '21-live-chart.png');

  log(`charts e2e: ${pass} ok, ${fail} failed`);
  await ctx.close();
  // cleanup the seeded conversation
  psql(`DELETE FROM ai_advisor.conversation WHERE id = ${convId}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
