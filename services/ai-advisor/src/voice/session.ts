// One VoiceSession per live Retell call: identity + auth tier, the model conversation, and the
// pending "side effects" a turn can request (end call, transfer). Durable facts are mirrored to
// voice_call / voice_call_event so a reconnect or restart can rehydrate, and so the audit trail
// exists whether or not the call finishes cleanly.
import type Anthropic from '@anthropic-ai/sdk';
import { resolveCallerContext, isAdvisorEnabled, type CallerCtx } from '../data-db';
import { config } from '../config';
import { voiceConfig } from './config';
import type { Candidate } from './identity';
import type { RetellCall, RetellUtterance } from './protocol';
import * as store from './store';
import type { CallDirection, CallOutcome, VoiceCallRow } from './store';
import { detectLanguage, languageName } from './languages';

export type AuthLevel = 0 | 1 | 2;

/** An outbound call's brief, from the outbound request (flow + payload). */
export interface OutboundBrief {
  requestId: number | null;
  flow: string;
  payload: Record<string, unknown>;
  clientUid: number | null;
  clientFirstName: string | null;
}

/** Anonymous scoping context for tier-0 (market/regulatory) tools: RLS returns no private rows. */
export function anonymousCtx(): CallerCtx {
  return { uid: 0, account: null, premium: false, accessClass: null, subclass: null, asof: config.asof };
}

export class VoiceSession {
  readonly createdAt = Date.now();
  row: VoiceCallRow;
  direction: CallDirection;
  fromNumber: string | null;
  toNumber: string | null;
  metadata: Record<string, unknown>;
  outbound: OutboundBrief | null = null;

  candidate: Candidate | null = null;
  ctx: CallerCtx | null = null;
  authLevel: AuthLevel = 0;
  /** verify_caller_details attempts this call (capped; see tools.ts). */
  knowledgeAttempts = 0;

  history: Anthropic.MessageParam[] = [];
  /** Agent-SDK backend only: the resumable session id for this call. */
  sdkSessionId: string | null = null;
  lastTranscript: RetellUtterance[] = [];
  lastUserUtterance: string | null = null;
  turnCount = 0;
  /** Silence reminders Retell has asked for on this call (reminder_required). */
  reminders = 0;

  /** Pending orders prepared during THIS call, with WHEN and WHAT: confirm is only allowed for these,
   *  only after a later caller turn that follows an agent read-back spoken after the prepare, and only
   *  when that read-back contains the order's volume and price figures (see confirm_prepared_order).
   *  `agentUtterances` = how many agent utterances preceded the caller's prepare-turn speech. */
  preparedOrders = new Map<number, { turn: number; agentUtterances: number; volumeMl: number | null; pricePerMl: number | null }>();
  /** Facts the caller supplied to identify_caller — they cannot double as verification factors. */
  identificationFacts = new Set<string>();
  /** Serialises turns on this call: a new turn waits for the superseded one to settle. */
  turnChain: Promise<void> = Promise.resolve();
  /** Set by tools during a turn; consumed when the turn's final chunk is sent. */
  pendingEndCall = false;
  pendingTransfer: string | null = null;
  /** True after a prepare_* tool ran this turn → read-back is spoken with no_interruption_allowed. */
  readbackThisTurn = false;
  disclosureDone = false;
  /** The caller's spoken language as a base code ('en', 'vi', …): SESSION state inferred from their speech
   *  each turn (observeUtterance) — never read from or written to a client record. Drives the code-spoken
   *  strings, the English unit rewriter gate and the model's call-state block. */
  language = 'en';
  /** Set when a language is detected for the first time on this call and the recording disclosure was
   *  only spoken in English: the model is told to restate it in that language once; cleared after the turn. */
  pendingDisclosureLang: string | null = null;
  private disclosedLangs = new Set<string>(['en']);
  optedOut = false;
  outcome: CallOutcome | null = null;
  ended = false;
  /** Serialises turns: a new response_required aborts the previous turn's generation. */
  currentAbort: AbortController | null = null;
  currentResponseId = -1;

  constructor(row: VoiceCallRow, direction: CallDirection, call: RetellCall | null) {
    this.row = row;
    this.direction = direction;
    this.fromNumber = call?.from_number ?? row.from_number ?? null;
    this.toNumber = call?.to_number ?? row.to_number ?? null;
    this.metadata = (call?.metadata as Record<string, unknown>) ?? row.metadata ?? {};
  }

  get id(): number { return this.row.id; }
  get retellCallId(): string { return this.row.retell_call_id; }
  get isOutbound(): boolean { return this.direction === 'outbound' || !!this.outbound; }

  async event(type: string, detail?: Record<string, unknown> | null): Promise<void> {
    try { await store.addCallEvent(this.id, type, detail ?? null); }
    catch (e: any) { console.error(`[voice] event write failed (${type}) call ${this.id}:`, e?.message ?? e); }
  }

  /** Nominate a candidate (grants nothing) and resolve their scoping context. */
  async setCandidate(c: Candidate | null): Promise<void> {
    const changed = (this.candidate?.uid ?? null) !== (c?.uid ?? null);
    this.candidate = c;
    if (changed) {
      // Everything earned belonged to the previous candidate: codes, verification level, prepared orders.
      this.preparedOrders.clear();
      this.identificationFacts.clear();
      if (this.authLevel > 0) { this.authLevel = 0; await store.resetCallAuthLevel(this.id); }
      await store.expireOtpsForCall(this.id);
    }
    if (c) {
      this.ctx = await resolveCallerContext(c.uid);
      await store.setCallIdentity(this.id, c.uid, c.accountId, c.by);
      await this.event('identified', { uid: c.uid, by: c.by });
    } else {
      this.ctx = null;
      await store.setCallIdentity(this.id, null, null, null);
    }
  }

  async grant(level: AuthLevel, how: string): Promise<void> {
    if (level > this.authLevel) {
      this.authLevel = level;
      await store.setCallAuthLevel(this.id, level);
    }
    // Event vocabulary: otp_verified (tier 2), identity_confirmed (tier 1 by name — a caller-ID/outbound
    // candidate confirming "yes, that's me", or name + one account detail), knowledge_verified (tier 1
    // by the optional two-fact check).
    const type = level === 2 ? 'otp_verified' : (how === 'name_confirmed' || how === 'self_identified') ? 'identity_confirmed' : 'knowledge_verified';
    await this.event(type, { level, how });
  }

  /** The scoping context tools run under: the verified/candidate client, else anonymous. */
  ctxFor(tier: AuthLevel): CallerCtx {
    if (tier === 0) return this.ctx ?? anonymousCtx();
    if (!this.ctx) throw new Error('no client context');
    return this.ctx;
  }

  /** Re-detect the caller's language from their latest words. Sticky: only a confident detection of a
   *  DIFFERENT configured language changes it (a "yes" or a number never does). Logged as a call event. */
  observeUtterance(text: string): void {
    const r = detectLanguage(text, voiceConfig.languageBases);
    if (!r.confident || r.lang === this.language) return;
    const from = this.language;
    this.language = r.lang;
    if (!this.disclosedLangs.has(r.lang)) { this.disclosedLangs.add(r.lang); this.pendingDisclosureLang = r.lang; }
    console.log(`[voice] call ${this.id} language ${from}→${r.lang}${this.pendingDisclosureLang === r.lang ? ' (disclosure pending)' : ''}: "${text.slice(0, 60)}"`);
    void this.event('language_detected', { from, to: r.lang, heard: text.slice(0, 120) });
  }

  async setOutcome(o: CallOutcome): Promise<void> {
    this.outcome = o;
    await store.setCallOutcome(this.id, o);
  }

  /**
   * Per-turn re-check of the client's AI-advisor flag (the chat surface checks it on every request; a
   * candidate nominated at call start must not keep access after staff flip the flag mid-call). Anything
   * but 'enabled' (disabled, or the lookup failed) drops the candidate and everything earned — fail closed.
   */
  async recheckAdvisorFlag(): Promise<boolean> {
    if (!this.candidate) return true;
    const flag = await isAdvisorEnabled(this.candidate.uid).catch(() => 'unknown' as const);
    if (flag === 'enabled') return true;
    await this.event('advisor_flag_revoked', { uid: this.candidate.uid, flag });
    await this.setCandidate(null);
    return false;
  }

  /** Human-readable state for the model's per-turn call-state block. */
  describeState(): string {
    // A self-named candidate is shown by first name only (anyone can name a client; the full name/company
    // on file is account data). Caller-ID / outbound-request candidates came from our own records.
    const shownName = this.candidate
      ? (this.candidate.by === 'self' ? (this.candidate.firstName ?? 'the named client') : this.candidate.displayName)
      : '';
    const who = this.candidate
      ? `${shownName} (${this.candidate.by === 'caller_id' || this.candidate.by === 'test_map' ? 'matched by caller ID — unconfirmed'
        : this.candidate.by === 'self' ? 'self-identified — unconfirmed' : 'named on the outbound request — unconfirmed'})`
      : 'unknown — not identified yet';
    const tier = this.authLevel === 2 ? 'VERIFIED FOR TRADING (code confirmed)'
      : this.authLevel === 1 ? 'VERIFIED FOR ACCOUNT INFORMATION (not for trading — a code is still required to place or withdraw an order)'
      : 'NOT VERIFIED (general market and regulatory information only; no account data, no orders)';
    const lines = [
      `Caller: ${who}.`,
      `Verification: ${tier}.`,
      `Call direction: ${this.isOutbound ? 'OUTBOUND (you placed this call)' : 'INBOUND (the caller rang Waterfind)'}.`,
    ];
    if (this.language !== 'en') {
      lines.push(`Caller's language: ${languageName(this.language)} (detected from their speech — speak ${languageName(this.language)}; if they switch, follow their latest turn).`);
      if (this.pendingDisclosureLang === this.language) lines.push(`The recording disclosure was spoken only in English: begin your reply with one sentence in ${languageName(this.language)} saying you are Waterfind's automated assistant and that the call may be recorded, then continue.`);
    }
    if (this.preparedOrders.size) lines.push(`Orders prepared this call (ids): ${[...this.preparedOrders.keys()].join(', ')} — awaiting the caller's spoken confirmation, or discard.`);
    if (this.knowledgeAttempts) lines.push(`Account-fact verification attempts used this call: ${this.knowledgeAttempts} of ${voiceConfig.knowledgeMaxAttemptsPerCall}.`);
    if (voiceConfig.transferEnabled) lines.push('Transfer to a human broker is available via escalate_to_broker.');
    else lines.push('Live transfer is NOT available right now; escalate_to_broker records a callback request instead.');
    return lines.join('\n');
  }
}

// ---- registry --------------------------------------------------------------------------------

const sessions = new Map<string, VoiceSession>();

export function getSession(retellCallId: string): VoiceSession | undefined { return sessions.get(retellCallId); }
export function putSession(s: VoiceSession): void { sessions.set(s.retellCallId, s); }
export function dropSession(retellCallId: string): void { sessions.delete(retellCallId); }
export function sessionCount(): number { return sessions.size; }

/** Drop sessions whose call ended long ago (belt and braces if a webhook never came). */
export function sweepSessions(maxAgeMs = 3 * 60 * 60_000): number {
  const now = Date.now();
  let n = 0;
  for (const [k, s] of sessions) {
    if (s.ended || now - s.createdAt > maxAgeMs) { sessions.delete(k); n++; }
  }
  return n;
}
