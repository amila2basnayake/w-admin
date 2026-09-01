// Clean-speech fake-microphone WAV: OpenAI TTS for each string in the plan, silences for each number.
//   node make-wav.mjs '[14,"Xin chào, tôi muốn biết giá nước…",40,"Cảm ơn. Còn vùng Murray thì sao?",40]' out.wav
// Key: AIADVISOR_OPENAI_API_KEY from ../../.env. Output 48 kHz mono PCM16.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, '..', '..', '.env'), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const key = env.AIADVISOR_OPENAI_API_KEY || env.OPENAI_API_KEY;
if (!key) throw new Error('no OpenAI key in .env');
const [planJson, out] = process.argv.slice(2);
if (!planJson || !out) throw new Error('usage: node make-wav.mjs <plan json> out.wav');

const OUT_RATE = 48000;
async function tts(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }),   // 24 kHz mono s16le
  });
  if (!res.ok) throw new Error('tts ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const pcm24 = Buffer.from(await res.arrayBuffer());
  const n = pcm24.length / 2;
  const up = Buffer.alloc(n * 4);   // 24 → 48 kHz, linear interpolation
  for (let i = 0; i < n; i++) {
    const a = pcm24.readInt16LE(i * 2), b = i + 1 < n ? pcm24.readInt16LE((i + 1) * 2) : a;
    up.writeInt16LE(a, i * 4); up.writeInt16LE(Math.round((a + b) / 2), i * 4 + 2);
  }
  return up;
}
const silence = (sec) => Buffer.alloc(Math.round(OUT_RATE * sec) * 2);

const parts = [];
for (const step of JSON.parse(planJson)) parts.push(typeof step === 'number' ? silence(step) : await tts(step));
const data = Buffer.concat(parts);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(OUT_RATE, 24); h.writeUInt32LE(OUT_RATE * 2, 28);
h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
writeFileSync(out, Buffer.concat([h, data]));
console.log('wrote', out, (data.length / 2 / OUT_RATE).toFixed(1) + 's');
