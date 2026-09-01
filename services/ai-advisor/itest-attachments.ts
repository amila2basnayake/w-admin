// Attachments integration test against a running sidecar (npm run dev / start).
// Covers upload validation, ownership, and LIVE model turns proving image / PDF / CSV
// content actually reaches the advisor (image + document content blocks via streaming input).
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './src/config';

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
const jsonH = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

let pass = 0, fail = 0;
const ok = (cond: boolean, label: string) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };

async function upload(token: string, filename: string, bytes: Buffer) {
  const r = await fetch(`${BASE}/attachments?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function j(method: string, path: string, token: string, body?: any) {
  const r = await fetch(BASE + path, { method, headers: jsonH(token), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function streamChat(path: string, token: string, body: any) {
  // A turn holds a per-conversation lock until its SDK stream finishes tearing down, which can
  // briefly outlast the client seeing `done`. These probes fire turns back-to-back, so retry a
  // 409 turn_in_progress (a real, human-paced client would not hit it) rather than failing.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(BASE + path, { method: 'POST', headers: jsonH(token), body: JSON.stringify(body) });
    if (res.status !== 409 || attempt >= 20) break;
    await res.json().catch(() => ({}));  // drain
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    return { status: res.status, deltas: '', done: null as any, error: (await res.json().catch(() => ({}))).error };
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '', deltas = '', done: any = null, error: string | undefined;
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
      else if (e.type === 'done') done = e;
      else if (e.type === 'error') error = e.message;
    }
  }
  return { status: res.status, deltas, done, error };
}

// ---- fixtures ------------------------------------------------------------------

/** Solid-colour RGB PNG built by hand (no deps): IHDR + deflated scanlines + IEND. */
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Minimal single-page PDF with one line of Helvetica text; xref offsets computed. */
function makePdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const CSV = Buffer.from(
  'month,water_use_ml\nJan-26,18.2\nFeb-26,21.7\nMar-26,34.9\nApr-26,12.1\nMay-26,9.4\n', 'utf8');

// ---- main ----------------------------------------------------------------------

async function main() {
  ok((await fetch(BASE + '/health')).status === 200, 'health 200');

  // upload validation
  const png = await upload(A, 'meter-photo.png', makePng(80, 80, [200, 30, 30]));
  ok(png.status === 200 && png.body.kind === 'image' && png.body.id > 0, `png upload -> image #${png.body.id}`);
  const csv = await upload(A, 'water-use.csv', CSV);
  ok(csv.status === 200 && csv.body.kind === 'text', `csv upload -> text #${csv.body.id}`);
  const pdf = await upload(A, 'statement.pdf', makePdf('Licence 2447507: approved annual volume is 42 ML.'));
  ok(pdf.status === 200 && pdf.body.kind === 'pdf', `pdf upload -> pdf #${pdf.body.id}`);

  ok((await upload(A, 'run.exe', Buffer.from('MZ...'))).status === 400, 'exe rejected -> 400');
  ok((await upload(A, 'fake.pdf', makePng(4, 4, [0, 0, 0]))).status === 400, 'png bytes as .pdf rejected (magic mismatch)');
  ok((await upload(A, 'huge.csv', Buffer.alloc(1048577, 0x61))).status === 400, 'oversized csv rejected');
  ok((await upload(A, 'binary.csv', Buffer.from([0x61, 0x00, 0x62]))).status === 400, 'NUL in text rejected');
  ok((await upload(A, 'empty.txt', Buffer.alloc(0))).status === 400, 'empty file rejected');

  // non-ASCII filename must survive upload AND download (Content-Disposition is latin-1 only)
  const uni = await upload(A, 'Report – July 2026.csv', CSV);
  ok(uni.status === 200, 'unicode filename upload accepted');
  const uniGet = await fetch(`${BASE}/attachments/${uni.body.id}`, { headers: { Authorization: `Bearer ${A}` } });
  ok(uniGet.status === 200 && /filename\*=UTF-8''/.test(uniGet.headers.get('content-disposition') || ''),
    'unicode filename download 200 with RFC 5987 disposition');

  // GET roundtrip + ownership
  const got = await fetch(`${BASE}/attachments/${png.body.id}`, { headers: { Authorization: `Bearer ${A}` } });
  const gotBytes = Buffer.from(await got.arrayBuffer());
  ok(got.status === 200 && got.headers.get('content-type') === 'image/png' && gotBytes.length === png.body.size_bytes,
    'GET roundtrip returns identical png');
  ok((await fetch(`${BASE}/attachments/${png.body.id}`, { headers: { Authorization: `Bearer ${B}` } })).status === 404,
    'IDOR: B cannot fetch A\'s attachment -> 404');

  // conversation wiring
  const conv = (await j('POST', '/conversations', A, {})).body;
  ok(!!conv.id, `created conversation #${conv.id}`);

  const crossUser = await streamChat(`/conversations/${conv.id}/chat`, A, { message: 'hi', attachment_ids: [999999999] });
  ok(crossUser.status === 404, 'unknown/foreign attachment id in chat -> 404');

  // live turn 1: CSV grounding (fresh session, single-message content blocks)
  const t1 = await streamChat(`/conversations/${conv.id}/chat`, A, {
    message: 'The attached CSV is my monthly water use. Which month used the most, and how many ML? Answer in one sentence.',
    attachment_ids: [csv.body.id],
  });
  ok(!!t1.done && !t1.error, `csv turn completed (${t1.deltas.length} chars)${t1.error ? ' err=' + t1.error : ''}`);
  // Assert on the user-visible answer: the redactor holds a trailing buffer during streaming and
  // delivers short answers whole in the `done` event, so check done.text (fall back to deltas).
  const ans1 = (t1.done?.text || t1.deltas);
  ok(/mar/i.test(ans1) && /34\.9/.test(ans1), `csv answer cites March 34.9 -> "${ans1.slice(0, 120)}"`);

  const msgs = (await j('GET', `/conversations/${conv.id}/messages`, A)).body;
  const um = msgs.find((m: any) => m.role === 'user');
  ok(um?.meta?.attachments?.[0]?.id === csv.body.id, 'user message meta records the attachment');

  // live turn 2: image via resumed session (streaming-input image block)
  const t2 = await streamChat(`/conversations/${conv.id}/chat`, A, {
    message: 'What is the dominant colour of the attached image? One word.',
    attachment_ids: [png.body.id],
  });
  ok(!!t2.done && !t2.error, `image turn completed (${t2.deltas.length} chars)${t2.error ? ' err=' + t2.error : ''}`);
  const ans2 = (t2.done?.text || t2.deltas);
  ok(/red/i.test(ans2), `image answer says red -> "${ans2.slice(0, 80)}"`);

  // live turn 3: PDF document block
  const t3 = await streamChat(`/conversations/${conv.id}/chat`, A, {
    message: 'What approved annual volume does the attached PDF state? Answer with just the number and unit.',
    attachment_ids: [pdf.body.id],
  });
  ok(!!t3.done && !t3.error, `pdf turn completed (${t3.deltas.length} chars)${t3.error ? ' err=' + t3.error : ''}`);
  const ans3 = (t3.done?.text || t3.deltas);
  ok(/42\s*ML/i.test(ans3), `pdf answer cites 42 ML -> "${ans3.slice(0, 80)}"`);

  // live turn 4: regenerate -> fresh-session rebuild re-embeds attachments
  const t4 = await streamChat(`/conversations/${conv.id}/regenerate`, A, {});
  const ans4 = (t4.done?.text || t4.deltas);
  ok(!!t4.done && !t4.error && /42\s*ML/i.test(ans4),
    `regenerate (rebuilt context incl. attachments) still cites 42 ML -> "${ans4.slice(0, 80)}"`);

  // reuse in a different conversation is refused
  const conv2 = (await j('POST', '/conversations', A, {})).body;
  const reuse = await streamChat(`/conversations/${conv2.id}/chat`, A, { message: 'analyse this', attachment_ids: [csv.body.id] });
  ok(reuse.status === 400, 'attachment bound to another conversation -> 400');

  // cleanup
  await j('DELETE', `/conversations/${conv.id}`, A);
  await j('DELETE', `/conversations/${conv2.id}`, A);

  console.log(`\nattachments itest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
