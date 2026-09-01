/**
 * Campaign demo driver: creates a real campaign through the real staff API (as admin), adds the five demo
 * clients, optionally launches it, and prints where to watch. Everything after that is the production
 * code path — feeder → dialer → (fake) Retell → voice agent → webhooks → the page.
 *   npm run demo:campaign -- --launch [--clients=uid,uid] [--name=...]   (sidecar on :3100 with RETELL_API_BASE pointing at the fake Retell)
 */
import 'dotenv/config';
import crypto from 'node:crypto';
const BASE = `http://127.0.0.1:${process.env.PORT || 3100}/voice/campaigns`;
const DEFAULT_CLIENTS = [1684153, 1611863, 2735, 269714, 87467];   // Ben Fessey, Cindy Kozel, Robert McGavin, Lewis Campbell, Rex Booker
const clientsArg = process.argv.find((a) => a.startsWith('--clients='));
const CLIENTS = clientsArg ? clientsArg.slice(10).split(',').map(Number).filter(Boolean) : DEFAULT_CLIENTS;
const NAME = process.argv.find((a) => a.startsWith('--name='))?.slice(7) || 'Demo: Murray allocation update';
function mint(uid: number, name: string, ut: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ uid, name, ut, iat: now, exp: now + 900, nonce: crypto.randomBytes(6).toString('hex') }), 'utf8').toString('base64url');
  return body + '.' + crypto.createHmac('sha256', process.env.AIADVISOR_SHARED_SECRET!).update(body).digest('base64url');
}
const tok = mint(10, 'Administrator Waterfind', 3);
async function api(path: string, method = 'GET', json?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${j.error ?? ''}`);
  return j;
}
(async () => {
  const c = await api('', 'POST', { name: NAME, flow: 'trade_opportunity', payload: {
    message: 'Allocation trade in the Victorian Murray high-reliability zones has picked up over the last fortnight, with buyers active below the Barmah Choke. If they have been thinking about selling some allocation this season, their broker can talk them through pricing.',
    broker_name: 'Sean Warren', region: 'Victorian Murray', callback_number: '1800 890 285' }, max_concurrent: 3 });
  const add = await api(`/${c.id}/members`, 'POST', { client_uids: CLIENTS });
  console.log(`campaign ${c.id} "${c.name}": added ${add.added}, skipped ${add.skipped}, unknown ${JSON.stringify(add.unknown)}`);
  const d = await api(`/${c.id}`);
  for (const m of d.members) console.log(`  ${m.client_name} ${m.to_number ?? ''} ${m.state}${m.skip_reason ? ' - ' + m.skip_reason : ''}`);
  if (process.argv.includes('--launch')) { await api(`/${c.id}/launch`, 'POST'); console.log('LAUNCHED'); }
  console.log('watch: http://localhost:81/ai-campaigns-home.html');
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
