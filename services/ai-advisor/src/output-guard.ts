import { config } from './config';

// Deterministic output-side guard (Workstream G defence-in-depth). The persona is hardened to never
// reveal internal plumbing or secret values, but a highly capable model has run-to-run variance
// under adversarial pressure. This layer makes the highest-severity, ZERO-false-positive leaks
// impossible regardless of what the model emits: a legitimate water-advice answer never contains an
// MCP tool id (`mcp__wf__…`), the internal RLS role/GUC, or a live secret value. We redact only
// those canaries — NOT advice phrasing or off-domain content, which carry real false-positive risk
// and stay handled by the persona + documented residual controls.

const REDACTION = '[redacted]';

// Whitespace-FREE canaries: internal identifiers that must never surface in a user-facing answer.
// Being whitespace-free lets the streaming redactor flush at whitespace boundaries safely (no such
// canary can straddle a space). Kept in sync with the LEAK set in test-redteam.mjs.
const STREAM_PATTERNS: RegExp[] = [
  /mcp__[a-z0-9_]+__[a-z0-9_]+/gi,          // fully-qualified MCP tool ids (mcp__wf__get_my_holdings)
  /\bai_advisor_ro\b/gi,                      // the internal read-only RLS role
  /\brunScoped\b/gi,                          // internal query helper name
  /current_setting\('ai\.(?:account|client)'/gi,
  /<\/?user_uploaded_file>/gi,                // attachment framing tokens
];

// Multi-word canaries (contain whitespace) — applied only in the authoritative final pass, which is
// the text the client actually renders (the `done` event replaces the streamed text) and persists.
const FINAL_ONLY_PATTERNS: RegExp[] = [
  /set\s+local\s+ai\.(?:account|client)\b/gi,
  /current_setting\(\s*'ai\.(?:account|client)'/gi,
];

/** Secret VALUES (not their variable names, which are public). Matched as exact literals, and only
 *  once long enough to be unambiguous. All are whitespace-free, so safe in the streaming path. */
function secretLiterals(): string[] {
  const out: string[] = [];
  const push = (v?: string) => { if (v && v.length >= 12) out.push(v); };
  try { push(config.sharedSecret); } catch { /* secret not configured in this env */ }
  try { push(config.execSecret); } catch { /* optional */ }
  push(config.anthropicApiKey);
  push(config.openaiApiKey);
  return out;
}

function applyPatterns(s: string, patterns: RegExp[]): string {
  let out = s;
  for (const re of patterns) out = out.replace(re, REDACTION);
  for (const lit of secretLiterals()) out = out.split(lit).join(REDACTION);
  return out;
}

/** Redact a complete message (used for the authoritative `done` text and the persisted copy). */
export function redactFinal(text: string): string {
  return applyPatterns(text, [...STREAM_PATTERNS, ...FINAL_ONLY_PATTERNS]);
}

/** True if a completed text still contains a canary (used by tests / assertions). */
export function containsCanary(text: string): boolean {
  return redactFinal(text) !== text;
}

/**
 * Streaming redactor: feed it delta chunks; it returns only the prefix that is safe to flush now,
 * holding back the trailing partial token so a whitespace-free canary spanning a delta boundary is
 * never emitted. It flushes up to and including the last whitespace char in the buffer — no
 * STREAM_PATTERN (all whitespace-free) can straddle a whitespace, so redacting either side of the
 * cut equals redacting the whole. Call flush() once at the end for the (redacted) remainder.
 */
export class StreamRedactor {
  private buf = '';

  push(chunk: string): string {
    this.buf += chunk;
    const cut = lastWhitespaceIndex(this.buf);
    if (cut < 0) return '';                       // no boundary yet — hold the whole (partial) token
    const emit = applyPatterns(this.buf.slice(0, cut + 1), STREAM_PATTERNS);
    this.buf = this.buf.slice(cut + 1);
    return emit;
  }

  flush(): string {
    const out = applyPatterns(this.buf, STREAM_PATTERNS);
    this.buf = '';
    return out;
  }
}

function lastWhitespaceIndex(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) return i;   // space, tab, LF, CR
  }
  return -1;
}
