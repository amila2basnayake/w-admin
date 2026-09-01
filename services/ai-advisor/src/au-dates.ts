/**
 * Australian-timezone date helpers. Every "today" in the BOM ingestion/freshness chain must be the
 * SYDNEY calendar date, not UTC: BOM issues on AEST/AEDT mornings, and a UTC "today" lags Sydney by
 * 10-11 hours. With UTC dates and a strict `>` comparison, a Wednesday-morning BOM reissue was not
 * even *eligible* for refresh until ~10am Sydney time on Thursday — a ~24-40h window every single
 * week in which a superseded outlook was served as current. (Found in the 2026-08 review.)
 */

/** Today's calendar date in Australia/Sydney, as YYYY-MM-DD. en-CA gives ISO ordering. */
export function sydneyToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Full ISO timestamp for attempt stamps. Refresh BACKOFF needs hour granularity: with date-only
 *  stamps a failed 00:15 attempt blocked retries for the whole calendar day even though the
 *  scheduler ticks every 6h. Day-granularity maths (daysBetween) still works on these, since the
 *  date is the leading 10 chars. */
export const nowIso = (): string => new Date().toISOString();

/** Hours from an ISO date or timestamp to now. Infinity when missing/unparseable, which reads as
 *  "never attempted" and fails toward refreshing. Date-only strings parse as UTC midnight — for
 *  backoff that overstates the age by up to a day, which errs toward retrying, the safe side. */
export function hoursSince(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return Infinity;
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) return Infinity;
  return (now.getTime() - t) / 3_600_000;
}
