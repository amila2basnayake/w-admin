/**
 * Render the scripted calls (call-scripts.ts) into phone-like WAV fixtures with OpenAI TTS:
 * two voices, each turn synthesised as 24 kHz PCM, downsampled to 8 kHz (what the PBX records),
 * gaps between turns, written as
 *   test/fixtures/calls/<id>.wav           8 kHz 16-bit MONO (both parties mixed on one channel)
 *   test/fixtures/calls/<id>.stereo.wav    8 kHz 16-bit STEREO (broker left, client right)
 *   test/fixtures/calls/<id>.dualmono.wav  8 kHz 16-bit STEREO carrying the SAME mix on both channels
 *                                          (what a PBX "stereo" MixMonitor file can be; derived from
 *                                          the mono file, no TTS call, and slightly attenuated on the
 *                                          right so a naive byte-equality check would not catch it)
 * plus <id>.json (the script) for the eval. Needs AIADVISOR_OPENAI_API_KEY for TTS (the dual-mono
 * derivation runs without it). Idempotent: existing files are kept unless --force. Fixtures are
 * gitignored (regenerate with: npm run callnotes:fixtures).
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config';
import { buildWav, downsample16, interleaveStereo, parseWav } from '../src/call-notes/wav';
import { CALL_SCRIPTS, type CallScript } from './call-scripts';

const OUT = join(process.cwd(), 'test', 'fixtures', 'calls');
const SR_IN = 24000, SR_OUT = 8000, FACTOR = SR_IN / SR_OUT;
const VOICES = { broker: 'onyx', client: 'nova' } as const;
const GAP_MS = 700;

async function tts(text: string, voice: string, instructions: string): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm', instructions }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());   // raw 24 kHz 16-bit mono LE
}

function silence(ms: number, sr: number): Buffer { return Buffer.alloc(Math.round(sr * ms / 1000) * 2); }

/** Same 16-bit mono PCM on both channels, right at -3 dB: a dual-mono "stereo" file. */
export function dualMonoFrom(monoWav: Buffer): Buffer {
  const info = parseWav(monoWav);
  if (!info || !info.pcm || info.channels !== 1 || info.bitsPerSample !== 16) throw new Error('dualMonoFrom: expects 16-bit mono PCM');
  const pcm = monoWav.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  const right = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) right.writeInt16LE(Math.round(pcm.readInt16LE(i) * 0.7), i);
  return buildWav(interleaveStereo(pcm, right), { channels: 2, sampleRate: info.sampleRate, bitsPerSample: 16 });
}

function deriveDualMono(id: string, force: boolean): void {
  const monoPath = join(OUT, `${id}.wav`), dmPath = join(OUT, `${id}.dualmono.wav`);
  if (!existsSync(monoPath) || (!force && existsSync(dmPath))) return;
  writeFileSync(dmPath, dualMonoFrom(readFileSync(monoPath)));
  console.log(`wrote  ${id}.dualmono.wav (derived)`);
}

async function render(script: CallScript, force: boolean): Promise<void> {
  const monoPath = join(OUT, `${script.id}.wav`), stereoPath = join(OUT, `${script.id}.stereo.wav`);
  writeFileSync(join(OUT, `${script.id}.json`), JSON.stringify(script, null, 2));
  if (!force && existsSync(monoPath) && existsSync(stereoPath)) { console.log(`keep   ${script.id}`); deriveDualMono(script.id, force); return; }
  if (!config.openaiApiKey) { console.log(`skip   ${script.id} (no AIADVISOR_OPENAI_API_KEY for TTS)`); return; }
  const mono: Buffer[] = [], left: Buffer[] = [], right: Buffer[] = [];
  for (const turn of script.turns) {
    const instr = turn.who === 'broker'
      ? 'Australian accent, friendly professional water broker on a phone call, natural pace.'
      : 'Australian accent, a farmer on the phone, relaxed, natural pace.';
    const pcm24 = await tts(turn.text, VOICES[turn.who], instr);
    const pcm8 = downsample16(pcm24, FACTOR);
    const gap = silence(GAP_MS, SR_OUT);
    mono.push(pcm8, gap);
    if (turn.who === 'broker') { left.push(pcm8, gap); right.push(Buffer.alloc(pcm8.length + gap.length)); }
    else { right.push(pcm8, gap); left.push(Buffer.alloc(pcm8.length + gap.length)); }
    process.stdout.write('.');
  }
  const monoPcm = Buffer.concat(mono);
  writeFileSync(monoPath, buildWav(monoPcm, { channels: 1, sampleRate: SR_OUT, bitsPerSample: 16 }));
  writeFileSync(stereoPath, buildWav(interleaveStereo(Buffer.concat(left), Buffer.concat(right)), { channels: 2, sampleRate: SR_OUT, bitsPerSample: 16 }));
  console.log(`\nwrote  ${script.id}  (${(monoPcm.length / 2 / SR_OUT).toFixed(1)} s)`);
  deriveDualMono(script.id, true);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const force = process.argv.includes('--force');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  for (const s of CALL_SCRIPTS) {
    if (only && s.id !== only) continue;
    await render(s, force);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
