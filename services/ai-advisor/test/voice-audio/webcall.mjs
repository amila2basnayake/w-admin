// Real audio web call: Chrome with a fake microphone playing a WAV, the demo page starts a Retell web
// call, and the live transcript is printed. See README.md.
//   node webcall.mjs C:/abs/path/caller.wav [seconds=130] [outname=webcall]
import { chromium } from 'playwright-core';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, '..', '..', '.env'), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL = process.env.VOICE_DEMO_URL || `${env.AIADVISOR_VOICE_PUBLIC_BASE}${env.AIADVISOR_VOICE_PUBLIC_PREFIX || ''}/voice/demo`;
const WAV = resolve(process.argv[2] || '');
const SECONDS = Number(process.argv[3] || 130);
const OUT = process.argv[4] || 'webcall';
if (!process.argv[2]) throw new Error('usage: node webcall.mjs <abs wav path> [seconds] [outname]');

const profile = mkdtempSync(join(tmpdir(), 'wf-webcall-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: false,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}%noloop`, '--autoplay-policy=no-user-gesture-required', '--window-size=1100,900'],
  permissions: ['microphone'],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !/loading/.test(document.getElementById('caps')?.textContent ?? 'loading'), null, { timeout: 20000 });
console.log('caps:', (await page.locator('#caps').innerText()).replace(/\s+/g, ' ').slice(0, 300));
await page.fill('#key', env.AIADVISOR_VOICE_DEMO_KEY || '');
await page.click('#start');
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < SECONDS * 1000) {
  await page.waitForTimeout(5000);
  const status = (await page.locator('#status').innerText()).trim();
  const tr = (await page.locator('#transcript').innerText()).trim();
  if (tr !== last) { console.log(`\n[${Math.round((Date.now() - t0) / 1000)}s] ${status}\n${tr}`); last = tr; }
  if (/Call ended|Could not start|Error:/.test(status)) { console.log(`\n[${Math.round((Date.now() - t0) / 1000)}s] ${status}`); break; }
}
await page.screenshot({ path: `${OUT}.png`, fullPage: true });
try { await page.click('#stop', { timeout: 2000 }); } catch { /* already ended */ }
await page.waitForTimeout(1500);
console.log('\nFINAL TRANSCRIPT:\n' + (await page.locator('#transcript').innerText()).trim());
await ctx.close();
