// Phone-quality degradation + fake-mic assembly with ffmpeg-static. See README.md.
//   node dirty.mjs out.wav '[14, {"src":"clip.m4a","from":12,"len":9}, 32, {"src":"clip2.m4a","from":40,"len":8}, 40]' [dirty|clean]
// dirty: narrowband (300–3400 Hz), 8 kHz round trip, pink noise (~12–15 dB SNR), compression, limiter.
// clean: clips laid out as they are. Output: 48 kHz mono PCM16 WAV (Chrome's fake capture format).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');

const [out, planJson, mode = 'dirty'] = process.argv.slice(2);
if (!out || !planJson) throw new Error('usage: node dirty.mjs out.wav <plan json> [dirty|clean]');
const plan = JSON.parse(planJson);
const RATE = 48000;
const silence = (sec) => Buffer.alloc(Math.round(RATE * sec) * 2);

function clip({ src, from = 0, len = 10, gain = 1 }) {
  const tmp = `${out}.clip.raw`;
  const dirty = ['highpass=f=300', 'lowpass=f=3400', 'aresample=8000', 'aresample=48000',
    'acompressor=threshold=-18dB:ratio=4:attack=5:release=50', `volume=${gain * 2.2}`, 'alimiter=limit=0.85'].join(',');
  const filter = mode === 'dirty'
    ? `[0:a]${dirty}[v];anoisesrc=color=pink:amplitude=0.03:duration=${len}:sample_rate=48000[n];[v][n]amix=inputs=2:duration=first:normalize=0`
    : `[0:a]aresample=48000,volume=${gain}`;
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', String(from), '-t', String(len), '-i', src, '-filter_complex', filter, '-ac', '1', '-ar', String(RATE), '-f', 's16le', tmp], { stdio: 'inherit' });
  const b = readFileSync(tmp); unlinkSync(tmp);
  return b;
}

const data = Buffer.concat(plan.map((p) => (typeof p === 'number' ? silence(p) : clip(p))));
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28);
h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
writeFileSync(out, Buffer.concat([h, data]));
console.log('wrote', out, (data.length / 2 / RATE).toFixed(1) + 's', mode);
