// End-to-end HTTP integration test against a running sidecar (npm start).
import crypto from 'node:crypto';
import { config } from '../config';

const BASE = `http://localhost:${config.port}`;

function mint(uid: number, name: string, ut: number): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { uid, name, ut, iat: now, exp: now + config.tokenTtl, nonce: crypto.randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', config.sharedSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
const A = mint(1273050473, 'Alice Client', 2);
const B = mint(555963683, 'Bob Client', 2);
const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
async function j(method: string, path: string, token: string, body?: any) {
  const r = await fetch(BASE + path, { method, headers: h(token), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, text: await r.text() };
}
const ok = (cond: boolean, label: string) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

async function streamChat(path: string, token: string, body: any) {
  const res = await fetch(BASE + path, { method: 'POST', headers: h(token), body: JSON.stringify(body) });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '', deltas = '', done: any = null, tools: string[] = [];
  while (true) {
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += dec.decode(value);
    const parts = buf.split('\n\n'); buf = parts.pop()!;
    for (const p of parts) {
      const line = p.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const e = JSON.parse(line.slice(6));
      if (e.type === 'delta') deltas += e.text;
      else if (e.type === 'tool') tools.push(e.name);
      else if (e.type === 'done') done = e;
      else if (e.type === 'error') { done = e; }
    }
  }
  return { deltas, done, tools, status: res.status };
}

async function main() {
  ok((await fetch(BASE + '/health')).status === 200, 'health 200');
  ok((await fetch(BASE + '/conversations')).status === 401, 'no-token -> 401');
  ok((await fetch(BASE + '/conversations', { headers: { Authorization: 'Bearer garbage.sig' } })).status === 401, 'bad-token -> 401');

  const me = JSON.parse((await j('GET', '/me', A)).text);
  ok(me.userId === 1273050473 && me.name === 'Alice Client', '/me reflects token identity');

  const conv = JSON.parse((await j('POST', '/conversations', A, {})).text);
  ok(!!conv.id, `created conversation #${conv.id}`);

  const idor = await j('GET', `/conversations/${conv.id}/messages`, B);
  ok(idor.status === 404, 'IDOR: B cannot read A\'s conversation by id -> 404');
  const idorDel = await j('DELETE', `/conversations/${conv.id}`, B);
  ok(idorDel.status === 404, 'IDOR: B cannot delete A\'s conversation -> 404');

  const chat = await streamChat(`/conversations/${conv.id}/chat`, A,
    { message: 'In one sentence, if seasonal allocations are high, does that usually push allocation (temporary) water prices down?' });
  ok(chat.deltas.length > 20, `chat streamed ${chat.deltas.length} chars`);
  ok(chat.done && chat.done.type === 'done' && !!chat.done.messageId, 'chat done event with messageId');
  ok(!!chat.done?.title && chat.done.title !== 'New chat', `auto-title set: "${chat.done?.title}"`);

  const msgs = JSON.parse((await j('GET', `/conversations/${conv.id}/messages`, A)).text);
  ok(msgs.length === 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant', 'history persisted [user, assistant]');
  const userMsgId = msgs[0].id;

  // follow-up (resume) turn
  const chat2 = await streamChat(`/conversations/${conv.id}/chat`, A, { message: 'And what about entitlement prices in that scenario?' });
  ok(chat2.deltas.length > 20, `follow-up streamed ${chat2.deltas.length} chars (resume)`);
  const msgs2 = JSON.parse((await j('GET', `/conversations/${conv.id}/messages`, A)).text);
  ok(msgs2.length === 4, 'history now has 4 messages');

  // edit-and-resend the first user message -> branch
  const edit = await streamChat(`/conversations/${conv.id}/messages/${userMsgId}/edit`, A,
    { content: 'In one sentence, what mainly drives allocation water prices?' });
  ok(edit.deltas.length > 20, `edit-and-resend streamed ${edit.deltas.length} chars`);
  const msgsAfterEdit = JSON.parse((await j('GET', `/conversations/${conv.id}/messages`, A)).text);
  ok(msgsAfterEdit.length === 2, `after edit, active branch truncated to 2 (was 4) -> ${msgsAfterEdit.length}`);

  // regenerate
  const regen = await streamChat(`/conversations/${conv.id}/regenerate`, A, {});
  ok(regen.deltas.length > 20, `regenerate streamed ${regen.deltas.length} chars`);
  const msgsAfterRegen = JSON.parse((await j('GET', `/conversations/${conv.id}/messages`, A)).text);
  ok(msgsAfterRegen.length === 2, 'after regenerate, still 2 active messages (assistant replaced)');

  // settings
  await j('PUT', '/settings', A, { theme: 'dark', custom_instructions: 'Always answer in one short sentence.' });
  const s = JSON.parse((await j('GET', '/settings', A)).text);
  ok(s.theme === 'dark' && s.custom_instructions?.includes('one short sentence'), 'settings persisted');

  // rename / search / export
  await j('PATCH', `/conversations/${conv.id}`, A, { title: 'Allocation price drivers' });
  const listA = JSON.parse((await j('GET', '/conversations', A)).text);
  ok(listA.find((c: any) => c.id === conv.id)?.title === 'Allocation price drivers', 'rename persisted');
  const search = JSON.parse((await j('GET', '/search?q=Allocation', A)).text);
  ok(search.some((c: any) => c.id === conv.id), 'search finds by title');
  const exp = await fetch(BASE + `/conversations/${conv.id}/export?format=md`, { headers: h(A) });
  const expText = await exp.text();
  ok(exp.status === 200 && expText.includes('# Allocation price drivers'), 'export md works');

  // isolation: B sees none of A's
  const listB = JSON.parse((await j('GET', '/conversations', B)).text);
  ok(!listB.some((c: any) => c.id === conv.id), 'B\'s list excludes A\'s conversation');

  // delete
  ok((await j('DELETE', `/conversations/${conv.id}`, A)).status === 200, 'A deletes own conversation');
  ok((await j('GET', `/conversations/${conv.id}/messages`, A)).status === 404, 'deleted conversation -> 404');

  console.log('\nintegration test complete');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
