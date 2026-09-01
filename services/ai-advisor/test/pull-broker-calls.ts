/**
 * Pull real broker call recordings from the CRM's PBX portal and transcribe them (diarised), for
 * studying how brokers actually work a call — e.g. what identity verification they do.
 *   npx tsx test/pull-broker-calls.ts <out-dir> <contact id> [<contact id> ...]
 * Uses the CRM's own phone_system_settings (AIADVISOR_PBX_SOURCE=db) through the Hetzner proxy tunnel
 * (AIADVISOR_PBX_PROXY, default http://127.0.0.1:9446) and the call-notes STT pipeline. Audio is kept in
 * memory only; the transcript + the CRM's own note for the call are written to <out-dir>/<contact id>.md.
 * Production PII — keep the output out of the repo.
 */
import './pbx-pull-env';   // must be the first import
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../src/db';
import { fetchRecordingOnce, pbxSettings } from '../src/call-notes/pbx';
import { transcribeCall } from '../src/call-notes/transcript';

const [, , outDir, ...ids] = process.argv;
if (!outDir || !ids.length) { console.error('usage: pull-broker-calls <out-dir> <contact id>...'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

async function main() {
  const settings = await pbxSettings();
  if (!settings) throw new Error('phone_system_settings not usable');
  for (const id of ids) {
    const r = await pool.query(
      `SELECT c.id, c.phonecall_id, c.date_edited, c.call_duration_seconds AS dur, c.incoming_phone_call AS inbound, c.phone_number,
              trim(regexp_replace(b.name, '\\s+', ' ', 'g')) AS broker,
              (SELECT trim(regexp_replace(u.name, '\\s+', ' ', 'g')) FROM waterfind_user u WHERE u.id = ru.primary_contact_user) AS client,
              (SELECT string_agg(to_char(n.date_edited, 'HH24:MI') || ' ' || regexp_replace(n.note, '\\s+', ' ', 'g'), E'\\n' ORDER BY n.date_edited)
                 FROM contact n WHERE n.registry_user = c.registry_user AND n.phone_record IS NOT TRUE AND n.added_by = c.added_by
                  AND n.date_edited BETWEEN c.date_edited AND c.date_edited + interval '30 minutes') AS notes
         FROM contact c JOIN waterfind_user b ON b.id = c.added_by LEFT JOIN registry_user ru ON ru.id = c.registry_user
        WHERE c.id = $1`, [Number(id)]);
    const row = r.rows[0];
    if (!row) { console.log(`${id}: no such contact`); continue; }
    process.stdout.write(`${id} ${row.inbound ? 'IN ' : 'OUT'} ${row.broker} <-> ${row.client} (${row.dur}s, ${row.phonecall_id}): fetching... `);
    const f = await fetchRecordingOnce(String(row.phonecall_id), settings);
    if (!f.ok) { console.log(`FAILED ${f.reason}: ${f.message}`); continue; }
    process.stdout.write(`${Math.round(f.audio.length / 1024)} KB ${f.ext}; transcribing... `);
    const t = await transcribeCall(f.audio, { ext: f.ext, mime: f.contentType });
    const md = `# Call ${row.id} — ${row.inbound ? 'INBOUND' : 'OUTBOUND'} — ${new Date(row.date_edited).toLocaleString()} — ${row.dur}s\n\n` +
      `Broker: ${row.broker}  \nClient (account primary contact): ${row.client}  \nPBX id: ${row.phonecall_id}  \nLayout: ${t.layout ?? '?'} (${t.channels ?? '?'} ch, ${t.diarized ? 'diarised' : 'not diarised'}, ${t.models.join('+')})${t.warnings.length ? '  \nWarnings: ' + t.warnings.join('; ') : ''}\n\n` +
      `## Transcript\n\n${t.text}\n\n## CRM notes the broker wrote after the call\n\n${row.notes ?? '(none within 30 min)'}\n`;
    writeFileSync(join(outDir, `${row.id}.md`), md);
    console.log(`done (${t.segments.length} segments)`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
