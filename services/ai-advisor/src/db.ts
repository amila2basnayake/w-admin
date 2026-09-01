import pg from 'pg';
import { config } from './config';

// Return int8 (bigint/bigserial) as JS numbers, not strings. All our ids (conversation/message
// serials, and CRM user ids ~1e9) are well within Number.MAX_SAFE_INTEGER, so `m.id === n`
// comparisons work. Without this, node-postgres yields strings and === against numbers fails.
pg.types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10)));

const { Pool } = pg;

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: 10,
  // Resolve unqualified names against our schema first — set at connection startup (no race).
  options: `-c search_path=${config.db.schema},public`,
});

// node-postgres emits 'error' on the Pool when an IDLE connection dies (Postgres restart, network
// blip). Unhandled, that error crashes the process — a single idle-client drop would take the whole
// sidecar down. Log with context and swallow; the pool replaces the dead client on the next
// checkout, so no reconnect logic is needed here.
pool.on('error', (err) => {
  console.error('[db] idle client error on primary pool:', err?.message ?? err);
});

export async function query<T extends pg.QueryResultRow = any>(text: string, params?: any[]) {
  return pool.query<T>(text, params);
}
