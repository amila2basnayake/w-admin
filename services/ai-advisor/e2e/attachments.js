// Browser e2e for chat attachments: attach a CSV + PNG through the real composer,
// run live advisor turns, and check chips/thumbnails render (including after reload).
//   node attachments.js   (CRM :81 + sidecar :3100 must be running)
const { chromium } = require('playwright-core');
const zlib = require('zlib');
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

// solid-colour PNG (same construction as itest-attachments.ts)
function makePng(w, h, rgb) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const CSV = Buffer.from('month,water_use_ml\nJan-26,18.2\nFeb-26,21.7\nMar-26,34.9\nApr-26,12.1\nMay-26,9.4\n', 'utf8');

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(process.cwd(), 'chrome-profile-attachments'),
    { channel: 'chrome', headless: HEADLESS, viewport: { width: 1440, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  const frame = page.frameLocator('#content-iframe');
  const ta = () => frame.locator('.wfai-composer textarea');

  async function waitTurnDone() {
    await page.waitForFunction(() => {
      const f = document.querySelector('#content-iframe'); const d = f && f.contentDocument;
      return !!(d && d.querySelector('.wfai-send') && d.querySelector('.wfai-send').classList.contains('stop'));
    }, null, { timeout: 60000 });
    await page.waitForFunction(() => {
      const f = document.querySelector('#content-iframe'); const d = f && f.contentDocument; if (!d) return false;
      const send = d.querySelector('.wfai-send');
      return send && !send.classList.contains('stop');
    }, null, { timeout: 300000 });
    await page.waitForTimeout(1200);
  }
  async function attach(name, mimeType, buffer) {
    await frame.locator('.wfai-file').setInputFiles({ name, mimeType, buffer });
    await frame.locator('.wfai-attach-row .wfai-att:not(.uploading)').first().waitFor({ timeout: 30000 });
  }

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
  await frame.locator('.wfai-newchat').click();
  log('advisor open');

  await step('attach button + hidden file input exist', async () => {
    if (!(await frame.locator('.wfai-attach').count())) throw new Error('no attach button');
    if (!(await frame.locator('.wfai-file').count())) throw new Error('no file input');
  });

  await step('csv attach shows a ready chip', async () => {
    await attach('water-use.csv', 'text/csv', CSV);
    const chip = await frame.locator('.wfai-attach-row .wfai-att').first().innerText();
    if (!/water-use\.csv/.test(chip)) throw new Error('chip missing filename: ' + chip);
  });
  await shot(page, '30-att-chip.png');

  await step('live csv turn answers from the file', async () => {
    await ta().fill('The attached CSV is my monthly water use. Which month used the most, and how many ML? One sentence.');
    await ta().press('Enter');
    await waitTurnDone();
    const ans = await frame.locator('.wfai-msg.assistant .content').last().innerText();
    if (!/34\.9/.test(ans)) throw new Error('answer does not cite 34.9: ' + ans.slice(0, 160));
  });

  await step('sent message shows the attachment chip; composer row cleared', async () => {
    const chip = await frame.locator('.wfai-msg.user .wfai-msg-atts .wfai-att').first().innerText();
    if (!/water-use\.csv/.test(chip)) throw new Error('message chip missing: ' + chip);
    if (await frame.locator('.wfai-attach-row').isVisible()) throw new Error('composer attach row still visible');
  });
  await shot(page, '31-att-sent.png');

  await step('live image turn answers from the picture', async () => {
    await attach('meter-photo.png', 'image/png', makePng(80, 80, [200, 30, 30]));
    await ta().fill('What is the dominant colour of the attached image? One word.');
    await ta().press('Enter');
    await waitTurnDone();
    const ans = await frame.locator('.wfai-msg.assistant .content').last().innerText();
    if (!/red/i.test(ans)) throw new Error('answer not red: ' + ans.slice(0, 120));
  });

  await step('image renders as a thumbnail in the sent message', async () => {
    const img = frame.locator('.wfai-msg.user .wfai-msg-atts .wfai-att.img img').last();
    const src = await img.getAttribute('src');
    if (!src || src.indexOf('blob:') !== 0) throw new Error('thumbnail src not a blob url: ' + src);
  });
  await shot(page, '32-att-image.png');

  await step('history reload re-renders chips + authed thumbnail', async () => {
    const title = await frame.locator('.wfai-head .title').innerText();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('a[data-menu-id="ai-advisor"]');
    await ta().waitFor({ timeout: 60000 });
    await frame.locator('.wfai-conv .t', { hasText: title.slice(0, 20) }).first().click();
    await frame.locator('.wfai-msg.user .wfai-msg-atts .wfai-att.img img').last().waitFor({ timeout: 20000 });
    const src = await frame.locator('.wfai-msg.user .wfai-msg-atts .wfai-att.img img').last().getAttribute('src');
    if (!src || src.indexOf('blob:') !== 0) throw new Error('reloaded thumbnail not a blob url: ' + src);
    const chips = await frame.locator('.wfai-msg.user .wfai-msg-atts .wfai-att').count();
    if (chips < 2) throw new Error('expected 2 attachment chips after reload, got ' + chips);
  });
  await shot(page, '33-att-reload.png');

  await step('oversized file is refused client-side', async () => {
    await frame.locator('.wfai-file').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(1048577, 0x61) });
    await page.waitForTimeout(800);
    if (await frame.locator('.wfai-attach-row .wfai-att').count()) throw new Error('oversized file produced a chip');
  });

  console.log(`\nattachments e2e: ${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
