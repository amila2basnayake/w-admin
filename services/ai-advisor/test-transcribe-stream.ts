/**
 * Live dictation relay (/transcribe/stream) tests.
 *   1. Pure protocol helpers — offline, deterministic.
 *   2. The relay against a FAKE upstream realtime socket (no key, no network): auth, audio pass-through
 *      (incl. pre-open buffering), commit -> final, per-user cap, upstream failure, dispatcher 404.
 *   3. LIVE (only with an OpenAI key in .env AND LIVE=1): streams test/fixtures/dictation-24k.wav
 *      through the real route and asserts the two utterances come back.
 *   npx tsx test-transcribe-stream.ts          LIVE=1 npx tsx test-transcribe-stream.ts
 */
process.env.AIADVISOR_SPEND_LEDGER = '0';   // mocked providers must not write to the spend ledger
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './src/config';
import {
  attachTranscribeStream, buildSessionUpdate, clampSilence, mapUpstreamEvent, STREAM_MODEL, _setUpstreamFactory, _liveStreams,
  SILENCE_DEFAULT_MS, SILENCE_MIN_MS, SILENCE_MAX_MS, MAX_STREAMS_PER_USER,
} from './src/transcribe-stream';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
function b64url(b: Buffer): string { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function mint(claims: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${body}.${b64url(crypto.createHmac('sha256', config.sharedSecret).update(body).digest())}`;
}
const now = Math.floor(Date.now() / 1000);
const tokenFor = (uid: number) => mint({ uid, name: 'Dictation Tester', ut: 2, iat: now, exp: now + 600, nonce: 'n' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. pure helpers --------------------------------------------------------
console.log('1. protocol helpers');
ok('clampSilence default', clampSilence(undefined) === SILENCE_DEFAULT_MS);
ok('clampSilence min', clampSilence(10) === SILENCE_MIN_MS);
ok('clampSilence max', clampSilence(99999) === SILENCE_MAX_MS);
ok('clampSilence rounds', clampSilence(650.4) === 650);
{
  const u = buildSessionUpdate(700) as any;
  ok('session.update shape', u.type === 'session.update' && u.session.type === 'transcription');
  ok('pcm 24k', u.session.audio.input.format.type === 'audio/pcm' && u.session.audio.input.format.rate === 24000);
  ok('stream model (whisper-1: plain ASR, cannot answer instructions)', u.session.audio.input.transcription.model === STREAM_MODEL && STREAM_MODEL === 'whisper-1');
  ok('vocabulary prompt sent', typeof u.session.audio.input.transcription.prompt === 'string' && /Murrumbidgee/.test(u.session.audio.input.transcription.prompt));
  ok('server vad with silence', u.session.audio.input.turn_detection.type === 'server_vad' && u.session.audio.input.turn_detection.silence_duration_ms === 700);
  ok('noise reduction', u.session.audio.input.noise_reduction.type === 'near_field');
  ok('language pinned to English by default', u.session.audio.input.transcription.language === 'en');
  const vi = buildSessionUpdate(700, 'vi') as any;
  ok('language override pins recognition', vi.session.audio.input.transcription.language === 'vi');
  ok('English vocabulary prompt not sent with a non-English pin', vi.session.audio.input.transcription.prompt === undefined);
  const auto = buildSessionUpdate(700, 'auto') as any;
  ok('auto omits the language field', !('language' in auto.session.audio.input.transcription));
  ok('auto keeps the vocabulary prompt', typeof auto.session.audio.input.transcription.prompt === 'string');
}
ok('map session.updated -> ready', JSON.stringify(mapUpstreamEvent({ type: 'session.updated' })) === JSON.stringify({ kind: 'send', event: { type: 'ready' } }));
ok('map speech_started', JSON.stringify(mapUpstreamEvent({ type: 'input_audio_buffer.speech_started', item_id: 'i1' })) === JSON.stringify({ kind: 'send', event: { type: 'speech_started', item: 'i1' } }));
ok('map speech_stopped', JSON.stringify(mapUpstreamEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'i1' })) === JSON.stringify({ kind: 'send', event: { type: 'speech_stopped', item: 'i1' } }));
ok('map delta', JSON.stringify(mapUpstreamEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: ' sell' })) === JSON.stringify({ kind: 'send', event: { type: 'delta', item: 'i1', text: ' sell' } }));
ok('map completed -> final (trimmed)', JSON.stringify(mapUpstreamEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: ' Sell 200 ML. ' })) === JSON.stringify({ kind: 'send', event: { type: 'final', item: 'i1', text: 'Sell 200 ML.' } }));
ok('map failed -> empty final', JSON.stringify(mapUpstreamEvent({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'i1' })) === JSON.stringify({ kind: 'send', event: { type: 'final', item: 'i1', text: '' } }));
ok('map empty-commit error ignored', mapUpstreamEvent({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'x' } }).kind === 'ignore');
ok('map other error fatal, generic message', (() => { const m = mapUpstreamEvent({ type: 'error', error: { code: 'invalid_request_error', message: 'secret detail' } }); return m.kind === 'fatal' && m.message === 'transcription failed'; })());
ok('map unknown ignored', mapUpstreamEvent({ type: 'conversation.item.added' }).kind === 'ignore');
ok('map garbage ignored', mapUpstreamEvent(null).kind === 'ignore');

// ---- 2. relay vs fake upstream ---------------------------------------------
interface FakeUp { wss: WebSocketServer; url: string; sessions: FakeSession[]; close: () => Promise<void> }
interface FakeSession { ws: WebSocket; bytes: number; updates: any[]; commits: number }
let fakeMode: 'normal' | 'fatal' | 'empty-commit-error' = 'normal';
let fakeOpenDelayMs = 0;
async function startFake(): Promise<FakeUp> {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv });
  const sessions: FakeSession[] = [];
  wss.on('connection', (ws) => {
    const s: FakeSession = { ws, bytes: 0, updates: [], commits: 0 };
    sessions.push(s);
    let started = false; let n = 0;
    ws.on('message', (d) => {
      const j = JSON.parse(String(d));
      if (j.type === 'session.update') { s.updates.push(j); ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated', session: j.session })); return; }
      if (j.type === 'input_audio_buffer.append') {
        s.bytes += Buffer.from(j.audio, 'base64').length;
        if (!started && s.bytes >= 4800) { started = true; ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'item_' + (++n), audio_start_ms: 0 })); }
        if (fakeMode === 'fatal' && s.bytes >= 9600) ws.send(JSON.stringify({ type: 'error', error: { code: 'server_error', message: 'boom' } }));
        return;
      }
      if (j.type === 'input_audio_buffer.commit') {
        s.commits++;
        if (fakeMode === 'empty-commit-error') { ws.send(JSON.stringify({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } })); return; }
        const id = 'item_' + n;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: 1000 }));
        ws.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: id }));
        for (const t of ['Sell', ' two', ' hundred', ' megalitres.']) ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, delta: t }));
        ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: 'Sell two hundred megalitres.' }));
        started = false;
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  return { wss, url: `ws://127.0.0.1:${port}/v1/realtime`, sessions, close: () => new Promise((r) => { wss.close(); srv.close(() => r()); }) };
}

interface Client { ws: WebSocket; events: any[]; closed: Promise<{ code: number; reason: string }>; next: (type: string, ms?: number) => Promise<any> }
function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events: any[] = [];
    const waiters: Array<{ type: string; res: (e: any) => void }> = [];
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
    ws.on('message', (d) => { const j = JSON.parse(String(d)); events.push(j); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].type === j.type) { waiters[i].res(j); waiters.splice(i, 1); } });
    ws.on('open', () => resolve({ ws, events, closed, next: (type, ms = 3000) => {
      const have = events.find((e) => e.type === type); if (have) return Promise.resolve(have);
      return new Promise((res) => { const w = { type, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(null); } }, ms); });
    } }));
    ws.on('error', reject);
  });
}

async function relayTests() {
  console.log('2. relay vs fake upstream');
  const fake = await startFake();
  _setUpstreamFactory(() => {
    if (!fakeOpenDelayMs) return new WebSocket(fake.url);
    // Simulate a slow upstream handshake: a socket that only connects after a delay.
    const w = new WebSocket(fake.url.replace('/v1/realtime', '/slow'));
    return w;
  });
  const srv = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachTranscribeStream(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `ws://127.0.0.1:${(srv.address() as any).port}`;
  const frame = Buffer.alloc(4800, 1);

  if (!config.openaiApiKey) {
    console.log('  (no OpenAI key: the route refuses with "transcription not configured" — asserting that, then skipping the rest of the relay tests)');
    const c = await connect(base + '/transcribe/stream');
    const e = await c.next('error');
    ok('unconfigured -> error', e?.message === 'transcription not configured');
    await c.closed; await fake.close(); srv.close();
    return;
  }

  // dispatcher: unknown path is 404'd
  {
    const r = await new Promise<string>((res) => { const w = new WebSocket(base + '/nope'); w.on('error', (e) => res(e.message)); w.on('open', () => res('opened')); });
    ok('unknown ws path rejected', /404/.test(r), r);
  }
  // first message must be start
  {
    const c = await connect(base + '/transcribe/stream');
    c.ws.send(frame);
    const cl = await c.closed;
    ok('binary before start -> 4001', cl.code === 4001, `${cl.code} ${cl.reason}`);
  }
  {
    const c = await connect(base + '/transcribe/stream');
    c.ws.send(JSON.stringify({ type: 'start', token: 'bogus.sig' }));
    const e = await c.next('error'); const cl = await c.closed;
    ok('bad token -> error + 4001', e?.message === 'invalid token' && cl.code === 4001);
  }
  // happy path: ready, audio relayed byte-for-byte, commit -> final, stop -> 1000
  {
    const c = await connect(base + '/transcribe/stream');
    c.ws.send(JSON.stringify({ type: 'start', token: tokenFor(777), silence_ms: 900 }));
    const ready = await c.next('ready');
    ok('ready after session.updated', !!ready);
    const s = fake.sessions[fake.sessions.length - 1];
    ok('silence_ms honoured upstream', s.updates[0]?.session?.audio?.input?.turn_detection?.silence_duration_ms === 900);
    ok('one live stream for uid', _liveStreams(777) === 1);
    for (let i = 0; i < 3; i++) c.ws.send(frame);
    const st = await c.next('speech_started');
    ok('speech_started relayed', st?.item === 'item_1');
    await sleep(50);
    ok('audio bytes relayed', s.bytes === 3 * 4800, String(s.bytes));
    c.ws.send(JSON.stringify({ type: 'commit' }));
    const fin = await c.next('final');
    ok('commit -> final text', fin?.item === 'item_1' && fin?.text === 'Sell two hundred megalitres.');
    ok('deltas relayed in order', c.events.filter((e) => e.type === 'delta').map((e) => e.text).join('') === 'Sell two hundred megalitres.');
    ok('speech_stopped relayed', c.events.some((e) => e.type === 'speech_stopped' && e.item === 'item_1'));
    // a second commit with no open utterance is NOT forwarded (would error upstream)
    c.ws.send(JSON.stringify({ type: 'commit' })); await sleep(50);
    ok('commit without open speech not forwarded', s.commits === 1, String(s.commits));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    const cl = await c.closed;
    ok('stop -> 1000', cl.code === 1000, String(cl.code));
    await sleep(20);
    ok('live count released', _liveStreams(777) === 0);
  }
  // oversize frame dropped, tiny frame dropped
  {
    const c = await connect(base + '/transcribe/stream');
    c.ws.send(JSON.stringify({ type: 'start', token: tokenFor(778) }));
    await c.next('ready');
    const s = fake.sessions[fake.sessions.length - 1];
    c.ws.send(Buffer.alloc(0)); c.ws.send(frame); await sleep(50);
    ok('empty frame ignored, normal frame relayed', s.bytes === 4800, String(s.bytes));
    c.ws.close();
    await c.closed;
  }
  // per-user cap
  {
    const cs: Client[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) { const c = await connect(base + '/transcribe/stream'); c.ws.send(JSON.stringify({ type: 'start', token: tokenFor(779) })); await c.next('ready'); cs.push(c); }
    const extra = await connect(base + '/transcribe/stream');
    extra.ws.send(JSON.stringify({ type: 'start', token: tokenFor(779) }));
    const e = await extra.next('error'); const cl = await extra.closed;
    ok(`per-user cap (${MAX_STREAMS_PER_USER}) -> 4029`, e?.message === 'too many dictation sessions' && cl.code === 4029);
    for (const c of cs) { c.ws.close(); await c.closed; }
    await sleep(20);
    ok('cap released on close', _liveStreams(779) === 0);
  }
  // upstream fatal error -> client error + close
  {
    fakeMode = 'fatal';
    const c = await connect(base + '/transcribe/stream');
    c.ws.send(JSON.stringify({ type: 'start', token: tokenFor(780) }));
    await c.next('ready');
    c.ws.send(frame); c.ws.send(frame); c.ws.send(frame);
    const e = await c.next('error'); const cl = await c.closed;
    ok('upstream fatal -> generic error + close', e?.message === 'transcription failed' && cl.code === 1011, `${e?.message} ${cl.code}`);
    fakeMode = 'normal';
  }
  // empty-commit upstream error is swallowed (session continues)
  {
    fakeMode = 'empty-commit-error';
    const c = await connect(base + '/transcribe/stream');
    c.ws.send(JSON.stringify({ type: 'start', token: tokenFor(781) }));
    await c.next('ready');
    c.ws.send(frame); await c.next('speech_started');
    c.ws.send(JSON.stringify({ type: 'commit' }));
    await sleep(150);
    ok('empty-commit error swallowed, socket open', c.ws.readyState === WebSocket.OPEN && !c.events.some((e) => e.type === 'error'));
    c.ws.close(); await c.closed;
    fakeMode = 'normal';
  }
  // pre-open buffering: frames sent before the upstream connects still arrive, in order
  {
    // the fake's /slow path: delay the upgrade by holding the request
    const slow = http.createServer();
    const slowWss = new WebSocketServer({ noServer: true });
    slow.on('upgrade', (req, socket, head) => setTimeout(() => slowWss.handleUpgrade(req, socket, head, (ws) => fake.wss.emit('connection', ws, req)), 400));
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    const slowUrl = `ws://127.0.0.1:${(slow.address() as any).port}/slow`;
    _setUpstreamFactory(() => new WebSocket(slowUrl));
    const c = await connect(base + '/transcribe/stream');
    c.ws.send(JSON.stringify({ type: 'start', token: tokenFor(782) }));
    // send audio immediately — upstream is not open yet
    for (let i = 0; i < 5; i++) c.ws.send(Buffer.alloc(4800, i + 1));
    const ready = await c.next('ready', 3000);
    ok('ready after slow upstream open', !!ready);
    await sleep(100);
    const s = fake.sessions[fake.sessions.length - 1];
    ok('pre-open audio delivered after open', s.bytes === 5 * 4800, String(s.bytes));
    c.ws.close(); await c.closed;
    slowWss.close(); slow.close();
    _setUpstreamFactory(() => new WebSocket(fake.url));
  }
  // fake upstream dies mid-session -> client told
  {
    const c = await connect(base + '/transcribe/stream');
    c.ws.send(JSON.stringify({ type: 'start', token: tokenFor(783) }));
    await c.next('ready');
    const s = fake.sessions[fake.sessions.length - 1];
    s.ws.close();
    const e = await c.next('error'); const cl = await c.closed;
    ok('upstream close -> error + close', e?.message === 'transcription ended' && cl.code === 1011, `${e?.message} ${cl.code}`);
  }

  await fake.close();
  srv.close();
}

// ---- 3. live ----------------------------------------------------------------
async function liveTest() {
  if (!config.openaiApiKey || process.env.LIVE !== '1') { console.log('3. live: skipped (needs an OpenAI key and LIVE=1)'); return; }
  console.log('3. live (real OpenAI realtime transcription)');
  _setUpstreamFactory(() => new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { Authorization: `Bearer ${config.openaiApiKey}` } }));
  const srv = http.createServer();
  attachTranscribeStream(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const c = await connect(`ws://127.0.0.1:${(srv.address() as any).port}/transcribe/stream`);
  c.ws.send(JSON.stringify({ type: 'start', token: tokenFor(790), silence_ms: 600 }));
  const ready = await c.next('ready', 8000);
  ok('live ready', !!ready);
  const pcm = fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'dictation-24k.wav')).subarray(44);
  const t0 = Date.now();
  for (let off = 0; off < pcm.length; off += 4800) { c.ws.send(pcm.subarray(off, off + 4800)); await sleep(100); } // real-time pacing
  // trailing silence lets the VAD close the last utterance
  for (let i = 0; i < 12; i++) { c.ws.send(Buffer.alloc(4800)); await sleep(100); }
  await sleep(1500);
  const finals = c.events.filter((e) => e.type === 'final').map((e) => e.text);
  console.log('   finals:', JSON.stringify(finals), `in ${Date.now() - t0} ms`);
  ok('two utterances transcribed', finals.length === 2);
  ok('utterance 1 mentions Murrumbidgee', /Murrumbidgee/i.test(finals[0] ?? ''));
  ok('utterance 2 mentions Goulburn', /Goulburn/i.test(finals[1] ?? ''));
  // whisper-1 transcribes per utterance (no token deltas); a delta-streaming model must delta first.
  const di = c.events.findIndex((e) => e.type === 'delta');
  ok('deltas (if any) precede finals', di === -1 || di < c.events.findIndex((e) => e.type === 'final'));
  c.ws.send(JSON.stringify({ type: 'stop' }));
  await c.closed;
  srv.close();
}

(async () => {
  await relayTests();
  await liveTest();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
