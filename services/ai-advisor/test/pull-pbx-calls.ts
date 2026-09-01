/**
 * Pull recordings straight from the PBX portal by Asterisk call id (for calls newer than the CRM DB
 * snapshot) and transcribe them, diarised, with the call-notes STT pipeline.
 *   npx tsx test/pull-pbx-calls.ts <out-dir> <pbx id>[:<label>] ...
 * Same plumbing as pull-broker-calls.ts (phone_system_settings creds, AIADVISOR_PBX_PROXY tunnel).
 * Audio stays in memory; transcripts go to <out-dir>/<id>.md. Production PII — keep out of the repo.
 */
import './pbx-pull-env';   // must be the first import
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../src/db';
import { fetchRecordingOnce, pbxSettings } from '../src/call-notes/pbx';
import { transcribeCall } from '../src/call-notes/transcript';

const [, , outDir, ...specs] = process.argv;
if (!outDir || !specs.length) { console.error('usage: pull-pbx-calls <out-dir> <pbx id>[:<label>]...'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

async function main() {
  const settings = await pbxSettings();
  if (!settings) throw new Error('phone_system_settings not usable');
  for (const spec of specs) {
    const [id, ...rest] = spec.split(':');
    const label = rest.join(':') || id;
    process.stdout.write(`${id} (${label}): fetching... `);
    const f = await fetchRecordingOnce(id, settings);
    if (!f.ok) { console.log(`FAILED ${f.reason}: ${f.message}`); continue; }
    process.stdout.write(`${Math.round(f.audio.length / 1024)} KB ${f.ext}; transcribing... `);
    const t = await transcribeCall(f.audio, { ext: f.ext, mime: f.contentType });
    const md = `# ${label} — PBX ${id}\n\nLayout: ${t.layout ?? '?'} (${t.channels ?? '?'} ch, ${t.diarized ? 'diarised' : 'not diarised'}, ${t.models.join('+')}, ${t.seconds ?? '?'} s)${t.warnings.length ? '  \nWarnings: ' + t.warnings.join('; ') : ''}\n\n## Transcript\n\n${t.text}\n`;
    writeFileSync(join(outDir, `${id}.md`), md);
    console.log(`done (${t.segments.length} segments, ${t.seconds ?? '?'} s)`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
