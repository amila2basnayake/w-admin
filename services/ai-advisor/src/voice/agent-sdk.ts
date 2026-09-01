// Alternate model backend: the Claude Agent SDK (the same runtime the chat surface uses), for
// environments that have Claude Code host credentials but no ANTHROPIC_API_KEY. Slower per turn than
// the Messages API path in agent.ts (a CLI process per turn), functionally identical: same tools,
// same tier gate (dispatchTool), same composed system prompt (agent.ts buildSystem: shared hard
// limits + voice persona + shared guardrails + call state), same sentence-level streaming.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { voiceConfig } from './config';
import { SentenceChunker, toSpoken } from './speech';
import { redactFinal } from '../output-guard';
import { dispatchTool, type VoiceTool } from './tools';
import { buildSystem, type TurnOptions, type TurnFlags } from './agent';
import { stringsFor } from './languages';
import type { VoiceSession } from './session';
import { recordSpend } from '../spend';

const here = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(here, '..', '..', 'agent-workdir');
mkdirSync(SANDBOX, { recursive: true });
const AGENT_NAME = 'waterfind-voice-advisor';

function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n) + ` …[truncated ${s.length - n} chars]`; }

/** What the SDK session gets as this turn's user prompt: the caller's words plus call context it cannot see. */
function turnPrompt(session: VoiceSession, kind: 'response' | 'reminder'): string {
  const parts: string[] = [];
  if (!session.sdkSessionId) {
    // First model turn on this call: the opening was spoken by code, the model has not seen it.
    const opening = session.history.find((m) => m.role === 'assistant');
    const openText = opening && typeof opening.content === 'string' ? opening.content : '';
    if (openText) parts.push(`[You opened the call with: "${openText}"]`);
  }
  // Barge-in: our last reply was re-aligned to what was actually heard.
  const lastAssistant = [...session.history].reverse().find((m) => m.role === 'assistant');
  const lastText = lastAssistant && typeof lastAssistant.content === 'string' ? lastAssistant.content
    : Array.isArray(lastAssistant?.content) ? (lastAssistant!.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
  if (lastText.endsWith('[cut off]')) parts.push(`[The caller interrupted your last reply; they heard only: "${lastText.replace(/\s*\[cut off\]$/, '')}"]`);
  if (kind === 'reminder') parts.push('[The caller has been silent for a while. Check briefly whether they are still there, or offer to wrap up.]');
  else parts.push(`Caller: ${session.lastUserUtterance ?? '(unclear audio)'}`);
  return parts.join('\n');
}

export async function runTurnSdk(session: VoiceSession, opts: TurnOptions): Promise<void> {
  const { emit, signal, tools } = opts;
  session.turnCount++;
  session.readbackThisTurn = false;
  const chunker = new SentenceChunker();
  let spokenAny = false, fillerUsed = false, streamed = '';
  let disclosureSpoken: string | null = null;   // handed back on supersede, see agent.ts
  const spoken = () => stringsFor(session.language);
  const say = (text: string) => {
    const s = toSpoken(redactFinal(text), session.language);
    if (!s) return;
    spokenAny = true;
    emit(s, false, { noInterrupt: session.readbackThisTurn });
  };
  const finish = (flags: TurnFlags = {}) => {
    const rest = chunker.flush();
    if (rest) say(rest);
    emit('', true, { endCall: session.pendingEndCall || flags.endCall, transferNumber: session.pendingTransfer ?? flags.transferNumber ?? null, noInterrupt: session.readbackThisTurn });
    session.pendingEndCall = false;
    session.pendingTransfer = null;
    session.pendingDisclosureLang = null;
  };
  /** Superseded (barge-in): the turn's pending side effects belong to a reply the caller cut off. What was
   *  spoken is kept in history (streamed text is pushed below / on the abort path). */
  const superseded = (recordSpoken: boolean) => {
    session.pendingEndCall = false;
    session.pendingTransfer = null;
    if (disclosureSpoken) { session.pendingDisclosureLang = disclosureSpoken; console.log(`[voice] call ${session.id} disclosure handed back (${disclosureSpoken})`); }
    if (recordSpoken && streamed.trim()) session.history.push({ role: 'assistant', content: streamed.trim() + ' [cut off]' });
  };

  const server = createSdkMcpServer({
    name: 'voice',
    version: '1.0.0',
    tools: tools.map((t: VoiceTool) => tool(t.name, t.description, t.shape as any, async (args: any) => {
      const r = await dispatchTool(session, t, t.name, args);
      return { content: [{ type: 'text' as const, text: truncate(r.text, voiceConfig.toolResultMaxChars) }], isError: r.isError || undefined };
    })),
    alwaysLoad: true,
  });
  // First reply in a newly detected language: the fixed disclosure line is spoken by code first (see agent.ts).
  const disclosure = session.pendingDisclosureLang ? stringsFor(session.pendingDisclosureLang).disclosure : '';
  if (disclosure) {
    disclosureSpoken = session.pendingDisclosureLang;
    say(disclosure);
    session.history.push({ role: 'assistant', content: disclosure });
    session.pendingDisclosureLang = null;
    spokenAny = false;   // not an answer: a failed model turn must still get the apology
    console.log(`[voice] call ${session.id} disclosure spoken in ${disclosureSpoken}`);
  }
  const allowed = tools.map((t) => `mcp__voice__${t.name}`);
  const system = buildSystem(session).map((b) => b.text).join('\n\n');
  const abort = new AbortController();
  const onOuter = () => abort.abort();
  signal.addEventListener('abort', onOuter, { once: true });
  const timeout = setTimeout(() => abort.abort(), voiceConfig.turnTimeoutMs);

  const options: Record<string, unknown> = {
    agent: AGENT_NAME,
    agents: { [AGENT_NAME]: { description: 'Waterfind phone advisor', prompt: system, model: voiceConfig.sdkModel, tools: allowed } },
    model: voiceConfig.sdkModel,
    permissionMode: 'dontAsk',
    allowedTools: allowed,
    mcpServers: { voice: server },
    includePartialMessages: true,
    settingSources: [],
    cwd: SANDBOX,
    maxTurns: voiceConfig.maxToolRounds + 2,
    abortController: abort,
  };
  if (session.sdkSessionId) options.resume = session.sdkSessionId;
  if (voiceConfig.anthropicApiKey) options.env = { ...process.env, ANTHROPIC_API_KEY: voiceConfig.anthropicApiKey };

  const prompt = turnPrompt(session, opts.kind) + (disclosure ? `\n[You have just said, in the caller's language: "${disclosure}" — continue from there, in that language.]` : '');
  try {
    const q = query({ prompt, options: options as any });
    for await (const msg of q as AsyncIterable<any>) {
      if (abort.signal.aborted) break;
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') session.sdkSessionId = msg.session_id;
          break;
        case 'stream_event': {
          const ev = msg.event;
          if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && voiceConfig.fillerEnabled && !spokenAny && !fillerUsed) {
            fillerUsed = true;
            const rest = chunker.flush(); if (rest) say(rest);
            const fillers = spoken().fillers;
            say(fillers[session.turnCount % fillers.length]);
          }
          if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text' && streamed && !/\s$/.test(streamed)) { streamed += ' '; }
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            streamed += ev.delta.text;
            for (const s of chunker.push(ev.delta.text)) say(s);
          }
          break;
        }
        case 'result':
          if (typeof msg.total_cost_usd === 'number') void recordSpend({ source: 'voice_agent', vendor: 'anthropic', model: voiceConfig.sdkModel, costUsd: msg.total_cost_usd, userId: session.row.client_uid });
          if (msg.subtype !== 'success') {
            console.warn(`[voice] sdk turn on call ${session.id} ended with ${msg.subtype}${msg.errors ? ': ' + String(msg.errors).slice(0, 200) : ''}`);
            if (!spokenAny) say(spoken().apology);
          }
          break;
        default: break;
      }
    }
    // Keep our history aligned for reconcile() (the model's memory lives in the SDK session; the
    // user turn was already appended by reconcile()).
    session.history.push({ role: 'assistant', content: streamed || '(no reply)' });
    if (signal.aborted) { superseded(false); return; }   // superseded: the newer turn owns the line
    finish();
  } catch (e: any) {
    if (signal.aborted) { chunker.flush(); superseded(true); return; }
    console.error(`[voice] sdk turn failed on call ${session.id}:`, e?.message ?? e);
    await session.event('turn_error', { message: String(e?.message ?? e).slice(0, 300), backend: 'sdk' });
    if (!spokenAny) say(spoken().apology);
    finish();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onOuter);
  }
}
