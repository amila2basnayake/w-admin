import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config';
import { retitleIfUnchanged } from './conversations';
import { recordSpend } from './spend';

/**
 * Haiku chat titler — a port of the internal Claude Code "haiku hook"
 * (~/.claude/hooks/first_prompt_title*.py) into the sidecar.
 *
 * Same general logic: when a conversation gets its first exchange, ask a small fast model for a
 * few-word name from the first message, sanitize it hard, and apply it AFTER the fact — the turn
 * itself never waits. Until the name lands, the truncated first message (deriveTitle) names the
 * chat, exactly as the hook lets the built-in titler hold the tab until its name arrives.
 *
 * Differences from the hook, on purpose:
 *  - Budget is 2-4 words: hundreds of water chats need the distinguishing detail (zone, product,
 *    action) that a 2-word cap tends to squeeze out.
 *  - The rename is guarded: UPDATE ... WHERE title = <the derived title>, so a user's manual
 *    rename in the meantime always wins.
 *  - Fail-silent: on any error or timeout the derived title simply stays.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(here, '..', 'agent-workdir');   // same empty workdir the advisor uses
mkdirSync(SANDBOX, { recursive: true });

const NAMING_INSTRUCTIONS =
  'You name chat sessions for an Australian water-trading advisor. Below is the first message of '
  + 'a new chat. Reply with ONLY a title for the chat: 2 to 4 words, never more. Capture what '
  + 'makes THIS chat specific — the zone, product, action or question (e.g. "Zone 10 Buy", '
  + '"Carryover Deadline NSW", "Holdings Valuation"). No punctuation, no quotes, no explanation.'
  + '\n\nFirst message:\n';

/** The hook's sanitize(), ported: strip punctuation, collapse, cap words and length. */
export function sanitizeTitle(raw: string): string | null {
  const cleaned = String(raw ?? '')
    .replace(/["'`*_.,:;!?()\[\]{}‘’“”‒-―]/g, ' ')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return words.slice(0, 4).join(' ').slice(0, 48);
}

/** One-shot Haiku naming call. Resolves to a sanitized title, or null on any failure. */
export async function generateChatTitle(firstMessage: string, opts: { onCost?: (usd: number) => void } = {}): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45_000);
  try {
    const options: Record<string, unknown> = {
      model: config.titlerModel,
      maxTurns: 1,
      allowedTools: [] as string[],
      settingSources: [] as string[],
      permissionMode: 'dontAsk',
      cwd: SANDBOX,
      abortController: ac,
    };
    if (config.anthropicApiKey) options.env = { ...process.env, ANTHROPIC_API_KEY: config.anthropicApiKey };
    const q = sdkQuery({ prompt: NAMING_INSTRUCTIONS + firstMessage.slice(0, 2000), options: options as any });
    for await (const msg of q as AsyncIterable<any>) {
      if (msg.type === 'result') {
        if (typeof msg.total_cost_usd === 'number') opts.onCost?.(msg.total_cost_usd);
        return msg.subtype === 'success' && typeof msg.result === 'string' ? sanitizeTitle(msg.result) : null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget: name a just-created conversation from its first message. Called after the
 * first turn's response has already ended; never throws, never blocks anything.
 */
export function titleConversationAsync(convId: number, derivedTitle: string, firstMessage: string): void {
  if (!config.titlerEnabled) return;
  const onCost = (usd: number) => void recordSpend({ source: 'titler', vendor: 'anthropic', model: config.titlerModel, costUsd: usd, ref: `conversation:${convId}:title` });
  void generateChatTitle(firstMessage, { onCost }).then(async (title) => {
    if (!title || title === derivedTitle) return;
    const applied = await retitleIfUnchanged(convId, derivedTitle, title);
    if (applied) console.log(`titler: conversation ${convId} -> "${title}"`);
  }).catch((e) => console.warn('titler: failed (derived title stays):', (e as Error)?.message));
}
