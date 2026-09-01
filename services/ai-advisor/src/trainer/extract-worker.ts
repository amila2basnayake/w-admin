import { parentPort, workerData } from 'node:worker_threads';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * worker_thread entry for text extraction (see ingest.ts extractText): pdf-parse / mammoth are
 * CPU-bound and ran on the request thread, where a hostile or merely huge PDF stalled every other
 * request. The parent posts { buf, filename }, caps the run at EXTRACT_TIMEOUT_MS and terminates
 * the worker on overrun.
 *
 * The sibling module is imported with an explicit extension, computed from this file's own: a
 * worker does not inherit the parent's tsx loader, so under Node's native type stripping a bare
 * './extract' would not resolve (and './extract.ts' would not type-check for a built .js tree).
 */
const { buf, filename } = workerData as { buf: Uint8Array; filename: string };
const sibling = new URL(`./extract${extname(fileURLToPath(import.meta.url))}`, import.meta.url).href;

import(sibling)
  .then((m: typeof import('./extract')) => m.extractTextInline(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), filename))
  .then((r) => parentPort!.postMessage(r))
  .catch((e) => parentPort!.postMessage({ text: null, status: 'failed', note: String((e as Error)?.message ?? e).slice(0, 300) }));
