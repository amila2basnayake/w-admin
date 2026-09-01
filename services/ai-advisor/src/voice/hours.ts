// Calling-hours arithmetic in the configured timezone (default Australia/Sydney). Used by the outbound
// guards, retry scheduling and the transfer decision.
import { voiceConfig } from './config';

type HoursCfg = { timezone: string; callingHours: { start: number; end: number }; callingWeekdaysOnly: boolean };

function localParts(d: Date, tz: string): { mins: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { mins: (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10), weekday: get('weekday') };
}

/** Inside the calling window right now? */
export function withinHours(now: Date, cfg: HoursCfg = voiceConfig): boolean {
  const { mins, weekday } = localParts(now, cfg.timezone);
  if (cfg.callingWeekdaysOnly && (weekday === 'Sat' || weekday === 'Sun')) return false;
  return mins >= cfg.callingHours.start && mins < cfg.callingHours.end;
}

/** The next instant (15-minute granularity) strictly after `from` that is inside the window; bounded to 8 days. */
export function nextCallingWindow(from: Date, cfg: HoursCfg = voiceConfig): Date {
  const step = 15 * 60_000;
  const limit = from.getTime() + 8 * 24 * 60 * 60_000;
  let t = from.getTime() + step;
  while (t < limit && !withinHours(new Date(t), cfg)) t += step;
  return new Date(t);
}
