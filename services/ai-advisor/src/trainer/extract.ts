import { extname } from 'node:path';

/**
 * Plain-text extraction from uploaded files (PDF, DOCX, text formats). Pure: no DB, no config, no
 * store — so extract-worker.ts can load it in a worker_thread without dragging the service in.
 * ingest.ts wraps extractTextInline in that worker with a time cap and a one-at-a-time queue;
 * the inline function is what both call.
 */

export type TextStatus = 'pending' | 'ok' | 'empty' | 'failed' | 'unsupported';
export interface Extracted { text: string | null; status: TextStatus; note: string | null }

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'log']);

export function fileKind(filename: string): 'pdf' | 'docx' | 'text' | 'image' | 'other' {
  const ext = extname(filename).slice(1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (TEXT_EXT.has(ext)) return 'text';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  return 'other';
}

/** Extract plain text from a stored file, on the calling thread. Never throws; reports status instead. */
export async function extractTextInline(buf: Buffer, filename: string): Promise<Extracted> {
  const kind = fileKind(filename);
  try {
    if (kind === 'pdf') {
      const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
      const r = await pdfParse(buf);
      const text = tidy(r.text);
      return text.length >= 40
        ? { text, status: 'ok', note: `${r.numpages} page${r.numpages === 1 ? '' : 's'}` }
        : { text: null, status: 'empty', note: `${r.numpages} page${r.numpages === 1 ? '' : 's'}, no extractable text (scanned?)` };
    }
    if (kind === 'docx') {
      const mammoth = await import('mammoth');
      const r = await mammoth.extractRawText({ buffer: buf });
      const text = tidy(r.value);
      return text.length >= 20 ? { text, status: 'ok', note: null } : { text: null, status: 'empty', note: 'no text in document' };
    }
    if (kind === 'text') {
      if (buf.includes(0)) return { text: null, status: 'failed', note: 'binary content in a text file' };
      let text = buf.toString('utf8');
      if (/\.html?$/i.test(filename)) text = stripHtml(text);
      text = tidy(text);
      return text.length ? { text, status: 'ok', note: null } : { text: null, status: 'empty', note: 'empty file' };
    }
    if (kind === 'image') return { text: null, status: 'unsupported', note: 'image — attach it to a chat message to discuss it' };
    return { text: null, status: 'unsupported', note: `no text extractor for ${extname(filename) || 'this file type'}` };
  } catch (e) {
    return { text: null, status: 'failed', note: (e as Error).message?.slice(0, 300) ?? 'extraction failed' };
  }
}

export function tidy(s: string): string {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}
function stripHtml(s: string): string {
  return s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}
