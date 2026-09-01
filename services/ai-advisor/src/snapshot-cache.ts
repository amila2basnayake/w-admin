import { readFileSync, statSync } from 'node:fs';

/**
 * Hot-reloading snapshot reader, shared by every knowledge/data/*.json consumer.
 *
 * Why: the refresh scheduler rewrites these files daily/weekly UNDER a long-running sidecar. The
 * BOM climate reader re-read on mtime change from day one, but the other snapshots (dam storage,
 * allocations, authority outlooks, NSW dashboards) were cached once at module init — so the
 * auto-refresh loop was dutifully updating files the process never looked at again, and two tools
 * could even disagree (get_climate_outlook re-read the drivers file per call while
 * get_authority_outlooks served its boot-time copy). One reader, one behaviour.
 *
 * Contract:
 *  - An mtime stat per access; re-parse only when the file changed. The refresh scripts write
 *    atomically (tmp + rename), so a read never catches a half-written file.
 *  - Fail-soft: missing/corrupt file degrades to null (or the last good copy if one was loaded) —
 *    never throws, never takes the sidecar down at import time.
 *  - A corrupt REWRITE keeps serving the last good copy and retries on the next access.
 */
export function snapshotReader(path: string, label = path): () => any | null {
  let cached: any | null = null;
  let cachedMtimeMs = -1;
  let warnedMissing = false;

  return () => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // Missing file: keep serving the last good copy if we ever had one, else report unavailable.
      if (cached == null && !warnedMissing) {
        console.error(`snapshot ${label}: missing/unreadable — will report unavailable`);
        warnedMissing = true;
      }
      return cached;
    }
    if (mtimeMs !== cachedMtimeMs) {
      try {
        const fresh = JSON.parse(readFileSync(path, 'utf8'));
        cached = fresh;
        cachedMtimeMs = mtimeMs;
        console.log(`snapshot ${label}: loaded (as_at ${fresh?.as_at ?? 'unknown'})`);
      } catch (e) {
        // A corrupt rewrite must not wipe a good snapshot; keep the last good copy, retry next call.
        if (cached == null) console.error(`snapshot ${label}: unparseable — will report unavailable`, e);
      }
    }
    return cached;
  };
}
