/**
 * Process-wide memory budget for call audio. Every upload being buffered and every recording a job
 * holds reserves its size here first; when the total would pass callNotesConfig.maxBytesInFlight
 * the request is refused (429) instead of growing the heap. A reservation shrinks once the real
 * size is known (PBX downloads reserve the cap up front) and is released when the job ends.
 */
import { callNotesConfig as C } from './config';
import { CallNoteError } from './transcript';

let inFlight = 0;

export interface ByteReservation {
  /** Bytes currently held by this reservation. */
  readonly bytes: number;
  /** Lower the reservation to the actual size (never raises it). */
  shrinkTo(n: number): void;
  /** Give it back. Idempotent. */
  release(): void;
}

export function bytesInFlight(): number { return inFlight; }

/** Reserve `n` bytes or throw a 429 CallNoteError. */
export function reserveBytes(n: number, what = 'audio'): ByteReservation {
  const want = Math.max(0, Math.floor(n));
  if (inFlight + want > C.maxBytesInFlight) {
    throw new CallNoteError(`The service is holding as much ${what} as it can right now — try again in a minute.`, 429, 'busy');
  }
  inFlight += want;
  let held = want;
  return {
    get bytes() { return held; },
    shrinkTo(m: number) {
      const to = Math.max(0, Math.min(held, Math.floor(m)));
      inFlight -= held - to; held = to;
    },
    release() { inFlight -= held; held = 0; if (inFlight < 0) inFlight = 0; },
  };
}

export function _resetBudgetForTests(): void { inFlight = 0; }
