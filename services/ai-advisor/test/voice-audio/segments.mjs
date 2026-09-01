// Segment-level transcript of a clip (whisper-1, verbose_json) so a coherent 6–20 s stretch can be chosen
// for dirty.mjs. Key: AIADVISOR_OPENAI_API_KEY from ../../.env.
//   node segments.mjs clip.m4a [vi]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, '..', '..', '.env'), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const key = env.AIADVISOR_OPENAI_API_KEY || env.OPENAI_API_KEY;
const [file, language] = process.argv.slice(2);
if (!file) throw new Error('usage: node segments.mjs clip.m4a [lang]');
const form = new FormData();
form.append('file', new Blob([readFileSync(file)]), file.split(/[\\/]/).pop());
form.append('model', 'whisper-1');
form.append('response_format', 'verbose_json');
if (language) form.append('language', language);
const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 300));
const j = await res.json();
console.log('language:', j.language, 'duration:', Math.round(j.duration));
for (const s of j.segments) console.log(`${s.start.toFixed(1).padStart(6)}-${s.end.toFixed(1).padEnd(6)} ${s.text.trim()}`);
