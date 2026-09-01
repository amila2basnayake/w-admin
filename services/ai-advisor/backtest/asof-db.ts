import pg from 'pg';
import { config } from '../src/config';

// =====================================================================================
//  As-of database for forecast backtesting (Workstream: forecast-backtest).
//
//  The whole trick: the forecast compute* functions take a Runner and use unqualified
//  table names. We create a `backtest_asof` schema whose views over the time-stamped
//  tables filter rows to <= a session GUC (`backtest.cutoff`), then run the SAME
//  unmodified compute functions with search_path = backtest_asof, public. To the tool,
//  the database looks exactly as it did on the cutoff date ("time travel"); outcome
//  extraction then reads the unmasked tables to score the forecast against what
//  actually happened.
//
//  Uses the admin connection (config.db) because view DDL is needed; the views are
//  read-only projections and the schema is idempotently recreated per run.
// =====================================================================================

pg.types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10)));

export type Runner = (sql: string, params?: any[]) => Promise<any[]>;

const SCHEMA = 'backtest_asof';

// cutoff GUC: unset/empty means "no masking" (view passes everything through)
const CUT = `COALESCE(NULLIF(current_setting('backtest.cutoff', true), '')::date, 'infinity'::date)`;

const VIEW_DDL = [
  `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`,
  // Masked (time-stamped) tables. Everything else resolves to public via search_path.
  `CREATE OR REPLACE VIEW ${SCHEMA}.water_allocation_reading AS
     SELECT * FROM public.water_allocation_reading WHERE effective_date <= ${CUT}`,
  `CREATE OR REPLACE VIEW ${SCHEMA}.soi_monthly_reading AS
     SELECT * FROM public.soi_monthly_reading WHERE date_read <= ${CUT}`,
  `CREATE OR REPLACE VIEW ${SCHEMA}.order_completed AS
     SELECT * FROM public.order_completed WHERE date_accepted <= ${CUT}`,
];

export class AsofDb {
  private client: pg.Client;

  constructor() {
    this.client = new pg.Client({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    });
  }

  async init(): Promise<void> {
    await this.client.connect();
    for (const ddl of VIEW_DDL) await this.client.query(ddl);
  }

  /**
   * Runner that sees the world as at `cutoff` (YYYY-MM-DD, inclusive).
   * The GUC + search_path are (re)pinned before every query so interleaved runners on
   * the same client cannot leak each other's cutoff.
   */
  runnerAt(cutoff: string): Runner {
    return async (sql, params = []) => {
      await this.client.query(
        `SELECT set_config('backtest.cutoff', $1, false),
                set_config('search_path', '${SCHEMA}, public', false)`,
        [cutoff],
      );
      const r = await this.client.query(sql, params);
      return r.rows;
    };
  }

  /** Runner with no masking (full history) — used for item generation and outcomes. */
  runnerFull(): Runner {
    return async (sql, params = []) => {
      await this.client.query(
        `SELECT set_config('backtest.cutoff', '', false),
                set_config('search_path', 'public', false)`,
      );
      const r = await this.client.query(sql, params);
      return r.rows;
    };
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
