/**
 * Unit tests for the dictation (speech-to-text) module: mime->extension mapping and the input
 * validation that runs BEFORE any network call, so the whole file is offline/deterministic.
 * The live OpenAI round-trip is only reachable with a real key + mic and is exercised manually
 * against the running sidecar (see crm-seam/README.md).
 *   npx tsx test-transcribe.ts
 */
import { extForMime, transcribeAudio, transcribeEnabled, TranscribeError } from './src/transcribe';
import { config } from './src/config';

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }
function eq(a: unknown, b: unknown, msg: string) {
  ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}
async function throwsStatus(fn: () => Promise<unknown>, status: number, msg: string) {
  try { await fn(); fail++; console.error('FAIL: expected a throw:', msg); }
  catch (e) {
    if (e instanceof TranscribeError) eq(e.status, status, msg);
    else { fail++; console.error('FAIL: wrong error type for', msg, e); }
  }
}

async function main() {
  // Content-Type -> filename extension OpenAI accepts.
  eq(extForMime('audio/webm'), 'webm', 'webm');
  eq(extForMime('audio/webm;codecs=opus'), 'webm', 'webm with codecs param stripped');
  eq(extForMime('AUDIO/MP4'), 'mp4', 'case-insensitive mp4');
  eq(extForMime('audio/ogg'), 'ogg', 'ogg');
  eq(extForMime('audio/wav'), 'wav', 'wav');
  eq(extForMime('audio/mpeg'), 'mp3', 'mpeg -> mp3');
  eq(extForMime('text/plain'), null, 'reject non-audio type');
  eq(extForMime(''), null, 'reject empty type');

  const good = Buffer.from('pretend-opus-bytes');

  // Validation precedes both the key check and the network call.
  await throwsStatus(() => transcribeAudio(Buffer.alloc(0), 'audio/webm'), 400, 'empty audio -> 400');
  await throwsStatus(() => transcribeAudio(Buffer.alloc(config.transcribeMaxBytes + 1), 'audio/webm'), 413, 'oversize -> 413');
  await throwsStatus(() => transcribeAudio(good, 'text/plain'), 415, 'unsupported format -> 415');

  // Behaviour with/without a configured key — neither branch touches the network here.
  if (!config.openaiApiKey) {
    eq(transcribeEnabled(), false, 'transcribeEnabled() false without a key');
    await throwsStatus(() => transcribeAudio(good, 'audio/webm'), 503, 'valid clip, no key -> 503');
  } else {
    eq(transcribeEnabled(), true, 'transcribeEnabled() true with a key');
    console.log('(OpenAI key present — skipping the offline 503 path; use the running sidecar for the live call)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
