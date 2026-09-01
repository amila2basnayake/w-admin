import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../db';

const here = dirname(fileURLToPath(import.meta.url)); // services/ai-advisor/src/db
const dbDir = join(here, '..', '..', 'db');           // services/ai-advisor/db
// Idempotent, in dependency order (attachment references conversation/message).
const SQL_FILES = ['schema.sql', 'projects.sql', 'brokerage.sql', 'attachments.sql', 'workflow.sql', 'feedback.sql', 'trainer.sql', 'assist.sql', 'call-notes.sql', 'voice.sql', 'campaigns.sql', 'default-questions.sql', 'kb-refresh.sql', 'spend.sql'];

async function main() {
  for (const f of SQL_FILES) {
    const path = join(dbDir, f);
    await pool.query(readFileSync(path, 'utf8'));
    console.log('applied', path);
  }
  await pool.end();
}

main().catch((e) => {
  console.error('schema init failed:', e);
  process.exit(1);
});
