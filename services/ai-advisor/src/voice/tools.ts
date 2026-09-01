// The phone agent's tools: the existing tenant-scoped data/brokerage/knowledge tools (same handlers,
// same RLS scoping) wrapped with a server-enforced verification TIER, plus the voice-only tools
// (identify, one-time code, knowledge factors, spoken order confirmation, escalation/transfer,
// callback, do-not-call, end call). The tier gate lives HERE, in the dispatcher — a tool the caller
// is not verified for returns a refusal to the model no matter what the transcript says.
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { buildToolDefs } from '../data-tools';
import { buildBrokerToolDefs } from '../broker-tools';
import { buildExtdataToolDefs } from '../extdata-tools';
import { buildForecastToolDefs } from '../forecast-tools';
import { buildKnowledgeToolDefs } from '../knowledge-tools';
import { searchNotes } from '../notes';
import type { CallerCtx } from '../data-db';
import {
  confirmPendingOrder, cancelPendingOrder, prepareEscalation, confirmEscalation,
  resolveBroker, insertBrokerAction, ScopeViolation, SeamUnknownOutcome, type PendingOrder, plain, recordOptOutInCrm } from '../brokerage';
import { query } from '../db';
import { voiceConfig } from './config';
import { classifyAffirmation } from './affirm';
import * as identity from './identity';
import { toE164, normalizeDigits, spokenTail } from './phone';
import * as store from './store';
import { withinHours } from './hours';
import { anonymousCtx, type VoiceSession, type AuthLevel } from './session';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type Handler = (args: any) => Promise<ToolResult>;

export interface VoiceTool {
  name: string;
  description: string;
  /** zod raw shape (the SDK backend rebuilds SDK tool() defs from it). */
  shape: Record<string, any>;
  /** JSON schema for the Messages API backend. */
  inputSchema: Record<string, unknown>;
  tier: AuthLevel;
  /** The candidate uid this tool set was built for (null = no candidate). dispatchTool refuses a tier>=1
   *  tool whose set was built for a different candidate than the session's current one. */
  forUid: number | null;
  handler: Handler;
}

/** Voice-only tool literal → VoiceTool (derives the JSON schema from the zod shape). */
function vt(t: Omit<VoiceTool, 'inputSchema'>): VoiceTool { return { ...t, inputSchema: shapeToJsonSchema(t.shape) }; }

function J(obj: unknown): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }

/** Zod raw shape (SDK tool defs) → JSON schema object for the Messages API. */
export function shapeToJsonSchema(shape: Record<string, any>): Record<string, unknown> {
  const js: any = z.toJSONSchema(z.object(shape ?? {}), { unrepresentable: 'any' });
  delete js.$schema;
  if (!js.type) js.type = 'object';
  if (!js.properties) js.properties = {};
  return js;
}

// Which existing tools the phone agent gets, and at what tier. Kept deliberately small: every tool
// definition is prompt tokens on every turn, and a phone answer is three sentences. Tier 0 = public
// market / regulatory / reference data (read-only, RLS returns no private rows under the anonymous
// ctx); tier 1 = the candidate's own account; tier 2 = order preparation. Validated against the real
// tool defs at startup and in test-voice.ts (validateVoiceToolAllowlists).
export const TIER0_DATA = new Set(['find_region', 'get_region_tradability', 'get_matchable_orders', 'get_market_liquidity',
  'get_price_band', 'get_market_reference', 'get_price_history_series', 'get_region_allocation', 'get_allocation_trajectory',
  'get_market_events', 'get_climate_drivers']);
export const TIER0_EXTDATA = new Set(['get_dam_storage', 'get_allocation_announcements', 'get_allocation_history', 'get_authority_outlooks',
  'get_climate_outlook', 'get_outlook_card', 'get_nsw_water_dashboards']);
export const TIER0_FORECAST = new Set(['forecast_allocation', 'forecast_temp_price', 'forecast_entitlement_value']);
export const TIER0_KNOWLEDGE = new Set(['search_knowledge', 'get_knowledge_doc']);
export const TIER1_DATA = new Set(['get_my_profile', 'get_my_holdings', 'get_my_trade_history', 'get_my_settlement_progress',
  'get_my_water_account', 'estimate_net_proceeds', 'get_my_fee_schedule', 'get_my_opportunities', 'estimate_my_seasonal_allocation']);
export const TIER1_BROKER = new Set(['get_my_open_orders', 'get_my_ai_orders']);
export const TIER2_BROKER = new Set(['prepare_sell_order', 'prepare_buy_order', 'prepare_order_withdrawal']);

/** Every allowlist, with the builder that must define each name (against any ctx). */
export const VOICE_TOOL_ALLOWLISTS: Array<{ list: Set<string>; builder: (ctx: CallerCtx) => Array<{ name: string }>; label: string }> = [
  { list: TIER0_DATA, builder: (ctx) => buildToolDefs(ctx), label: 'TIER0_DATA' },
  { list: TIER0_EXTDATA, builder: (ctx) => buildExtdataToolDefs(ctx), label: 'TIER0_EXTDATA' },
  { list: TIER0_FORECAST, builder: (ctx) => buildForecastToolDefs(ctx), label: 'TIER0_FORECAST' },
  { list: TIER0_KNOWLEDGE, builder: () => buildKnowledgeToolDefs({ searchNotes }), label: 'TIER0_KNOWLEDGE' },
  { list: TIER1_DATA, builder: (ctx) => buildToolDefs(ctx), label: 'TIER1_DATA' },
  { list: TIER1_BROKER, builder: (ctx) => buildBrokerToolDefs(ctx, null), label: 'TIER1_BROKER' },
  { list: TIER2_BROKER, builder: (ctx) => buildBrokerToolDefs(ctx, null), label: 'TIER2_BROKER' },
];

/**
 * Startup validation: every name in every tier allowlist must resolve to a real tool definition. A
 * typo here would otherwise silently drop a tool from the phone agent. Throws listing the unknown names.
 */
export function validateVoiceToolAllowlists(): void {
  const dummy: CallerCtx = { ...anonymousCtx(), uid: 1, account: 1 };
  const unknown: string[] = [];
  for (const { list, builder, label } of VOICE_TOOL_ALLOWLISTS) {
    const names = new Set(builder(dummy).map((d) => d.name));
    for (const n of list) if (!names.has(n)) unknown.push(`${label}:${n}`);
  }
  if (unknown.length) throw new Error(`voice tool allowlists name tools that do not exist: ${unknown.join(', ')}`);
}

const VOICE_PREPARE_NOTE =
  'AWAITING_SPOKEN_CONFIRMATION: nothing has been placed. Read back to the caller, in one clear sentence, ' +
  'the side, product, the volume in megalitres and the price per megalitre exactly as given in this result ' +
  '(the server checks your read-back contains both figures), the zone/region name, and any expiry, forward ' +
  'date or split terms, then ask ONE question: whether they confirm the order AND accept Waterfind\'s terms ' +
  'and conditions. Only after the caller answers call confirm_prepared_order with this pending_order_id. ' +
  'If they want any change, call discard_prepared_order and prepare a new one.';

function describeOrder(po: PendingOrder): string {
  const side = po.side === 'WITHDRAW' ? 'withdrawal of order' : po.side === 'SELL' ? 'sell' : 'buy';
  if (po.side === 'WITHDRAW') return `${side} #${po.target_order_id}`;
  const prod = po.is_permanent ? 'entitlement' : 'allocation';
  return `${side} ${po.volume_ml} ML of ${prod} in ${po.region_name ?? 'the region'} at $${po.price_per_ml}/ML` +
    (po.delivery_date ? ` for delivery ${po.delivery_date}` : '') + (po.split ? ' (split allowed)' : '');
}

type SdkDef = { name: string; description: string; inputSchema?: Record<string, any>; handler: (args: any, extra: unknown) => Promise<any> };

/**
 * Wrap an existing SDK tool def as a VoiceTool. `lookup` resolves the def AT CALL TIME under the
 * session's CURRENT scoping context (tier 0: candidate ctx or anonymous; tier 1/2: the candidate's ctx),
 * so a tool never runs under a context captured when the set was built. Arguments are validated and
 * defaulted through the def's zod shape (the SDK would do this for the chat surface; the Messages API
 * path hands us raw JSON), and a validation failure is a tool error, never a handler call.
 */
function wrap(session: VoiceSession, proto: SdkDef, tier: AuthLevel, lookup: (ctx: CallerCtx) => SdkDef | undefined,
  post?: (r: ToolResult, args: any) => Promise<ToolResult> | ToolResult, descriptionOverride?: string): VoiceTool {
  const shape = proto.inputSchema ?? {};
  const schema = z.object(shape);
  return {
    name: proto.name,
    description: descriptionOverride ?? proto.description,
    shape,
    inputSchema: shapeToJsonSchema(shape),
    tier,
    forUid: session.candidate?.uid ?? null,
    handler: async (args) => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'invalid arguments', detail: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 6) }) }] };
      }
      const ctx = session.ctxFor(tier);
      const def = lookup(ctx);
      if (!def) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'tool unavailable' }) }] };
      const r = await def.handler(parsed.data, {});
      return post ? post(r as ToolResult, parsed.data) : (r as ToolResult);
    },
  };
}

/** Number of agent utterances in the transcript BEFORE the caller's most recent utterance. */
function agentUtterancesBeforeLastUser(t: Array<{ role: string; content?: string }>): number {
  let lastUser = -1;
  for (let i = t.length - 1; i >= 0; i--) if (t[i]?.role === 'user') { lastUser = i; break; }
  const upto = lastUser < 0 ? t.length : lastUser;
  let n = 0;
  for (let i = 0; i < upto; i++) if (t[i]?.role === 'agent') n++;
  return n;
}

/**
 * Build the toolset for a session. Rebuilt whenever the candidate changes (ws.ts); the tier-1/2 tools
 * only exist once a candidate is nominated, and every tool carries the uid it was built for so the
 * dispatcher can refuse a stale set mid-turn (identify → verify → account tool in ONE model turn).
 */
export function buildVoiceTools(session: VoiceSession): VoiceTool[] {
  const tools: VoiceTool[] = [];
  const hasCandidate = !!session.candidate;
  const byName = (defs: SdkDef[], name: string) => defs.find((d) => d.name === name);
  // Prototypes (for names/descriptions/shapes) — the handlers actually run come from a fresh build
  // under the call-time ctx (see wrap()).
  const protoCtx = session.ctxFor(0);
  const dataProto = buildToolDefs(protoCtx) as SdkDef[];
  const extProto = buildExtdataToolDefs(protoCtx) as SdkDef[];
  const fcProto = buildForecastToolDefs(protoCtx) as SdkDef[];
  const knowledgeDefs = buildKnowledgeToolDefs({ searchNotes }) as SdkDef[];
  const brokerProto = (hasCandidate ? buildBrokerToolDefs(session.ctx!, null) : []) as SdkDef[];

  // ---- tier 0: public market/regulatory tools (anonymous or client ctx; RLS decides) ----
  for (const d of dataProto) if (TIER0_DATA.has(d.name)) tools.push(wrap(session, d, 0, (ctx) => byName(buildToolDefs(ctx) as SdkDef[], d.name)));
  for (const d of extProto) if (TIER0_EXTDATA.has(d.name)) tools.push(wrap(session, d, 0, (ctx) => byName(buildExtdataToolDefs(ctx) as SdkDef[], d.name)));
  for (const d of fcProto) if (TIER0_FORECAST.has(d.name)) tools.push(wrap(session, d, 0, (ctx) => byName(buildForecastToolDefs(ctx) as SdkDef[], d.name)));
  for (const d of knowledgeDefs) if (TIER0_KNOWLEDGE.has(d.name)) tools.push(wrap(session, d, 0, () => d));

  // ---- tier 1/2: the client's own account + orders (only exist once a candidate is nominated) ----
  if (hasCandidate) {
    for (const d of dataProto) if (TIER1_DATA.has(d.name)) tools.push(wrap(session, d, 1, (ctx) => byName(buildToolDefs(ctx) as SdkDef[], d.name)));
    for (const d of brokerProto) {
      const lookup = (ctx: CallerCtx) => byName(buildBrokerToolDefs(ctx, null) as SdkDef[], d.name);
      if (TIER1_BROKER.has(d.name)) tools.push(wrap(session, d, 1, lookup));
      if (TIER2_BROKER.has(d.name)) {
        tools.push(wrap(session, d, 2, lookup, async (r) => {
          // Swap the chat-card note for the spoken read-back protocol; remember the id AND the figures so
          // that confirm_prepared_order can only ever act on an order prepared in THIS call, and only
          // after a read-back that actually contained those figures.
          try {
            const obj = JSON.parse(r.content[0]?.text ?? '{}');
            if (obj?.order?.pending_order_id) {
              const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
              session.preparedOrders.set(Number(obj.order.pending_order_id), {
                turn: session.turnCount,
                agentUtterances: agentUtterancesBeforeLastUser(session.lastTranscript),
                volumeMl: num(obj.order.volume_ml), pricePerMl: num(obj.order.price_per_ml),
              });
              session.readbackThisTurn = true;
              obj.note = VOICE_PREPARE_NOTE;
              await session.event('order_prepared', { pending_order_id: obj.order.pending_order_id, side: obj.order.side, region: obj.order.region, volume_ml: obj.order.volume_ml, price_per_ml: obj.order.price_per_ml });
              return J(obj);
            }
          } catch { /* fall through with the original */ }
          return r;
        }, d.description.replace(/the user must (?:explicitly )?confirm in the chat UI[^.]*\./i, 'the caller must confirm it aloud on this call (see confirm_prepared_order).')
                       .replace(/that the user must explicitly confirm in the chat UI before anything is placed on the market/i, 'that the caller must confirm aloud before anything is placed on the market')));
      }
    }
  }

  const forUid = session.candidate?.uid ?? null;
  const voiceTool = (t: Omit<VoiceTool, 'inputSchema' | 'forUid'>): VoiceTool => vt({ ...t, forUid });

  // ---- voice-only tools ----
  tools.push(voiceTool({
    name: 'identify_caller',
    tier: 0,
    description: 'Look up which Waterfind client is on the line from what they tell you: their name (person or company) ' +
      'plus at least one identifier — customer number, the email on their account, ABN, or postcode. A match ' +
      'identifies them for account information (name plus one account detail — what a broker accepts); a one-time ' +
      'code is still required before any order. Never guess identifiers; ask the caller. Use also when caller-ID ' +
      'matched the wrong person.',
    shape: ({
      name: z.string().optional().describe('name as spoken (person or company)'),
      customer_number: z.string().optional().describe('Waterfind customer/client number (digits)'),
      email: z.string().optional().describe('email address on the account'),
      abn: z.string().optional().describe('ABN (digits)'),
      postcode: z.string().optional().describe('postcode on the account'),
    }),
    handler: async (a) => {
      const r = await identity.identifyBySelf(a);
      if (!r.candidate) return J({ status: r.reason, next: r.reason === 'need_identifier' ? 'ask for the customer number or the email on the account' : r.reason === 'ambiguous' ? 'ask for one more identifier (customer number, email or ABN)' : 'ask them to check the details, or offer a broker callback' });
      await session.setCandidate(r.candidate);
      // Facts used to FIND the account cannot also count as verification of it (postcode/ABN are public).
      for (const k of ['postcode', 'abn', 'email', 'customer_number'] as const) if (String(a[k] ?? '').trim()) session.identificationFacts.add(k);
      // Name + one account detail is the check a broker makes before discussing an account: that is
      // account-information level. Orders still need the code (tier 2).
      await session.grant(1, 'self_identified');
      // First name only: the full name / company on file is account data, and anyone can name a client.
      return J({ status: 'identified', level: 'account_information', first_name: r.candidate.firstName,
        next: 'Account tools become available from your next turn. send_verification_code only if they want to place or withdraw an order.' });
    },
  }));

  tools.push(voiceTool({
    name: 'confirm_caller_identity',
    tier: 0,
    description: 'When caller-ID matched a candidate (inbound) or you placed the call to a named client (outbound) and you asked ' +
      '"Am I speaking with <first name>?" — call this with their answer. A yes confirms them for account information ' +
      '(the same check a broker makes; no code needed for that). A no clears the candidate. A one-time code is still ' +
      'required before any order or withdrawal.',
    shape: ({ is_that_person: z.boolean() }),
    handler: async (a) => {
      if (!session.candidate) return J({ status: 'no_candidate' });
      if (!a.is_that_person) { await session.setCandidate(null); return J({ status: 'cleared', next: 'ask who is calling and use identify_caller' }); }
      await session.grant(1, 'name_confirmed');
      return J({ status: 'confirmed', level: 'account_information', first_name: session.candidate.firstName,
        next: 'account information may be discussed from your next turn; send_verification_code only if they want to place or withdraw an order' });
    },
  }));

  tools.push(voiceTool({
    name: 'send_verification_code',
    tier: 0,
    description: 'Send a six-digit one-time code to the mobile (or email) Waterfind has on file for the candidate client. ' +
      'Required before any order can be placed or withdrawn; also verifies the caller for account information. ' +
      'Tell the caller where it went (only the last digits are given to you) and ask them to read it back. ' +
      'Never ask them to spell out their full number, and never say the code yourself.',
    shape: ({ prefer: z.enum(['sms', 'email']).optional().describe('channel to prefer if both exist') }),
    handler: async (a) => {
      if (!session.candidate) return J({ status: 'no_candidate', next: 'identify the caller first (identify_caller)' });
      const r = await identity.sendOtp(session.id, session.candidate.uid, a.prefer ?? null);
      await session.event(r.ok ? 'otp_sent' : 'otp_send_failed', { channel: r.channel ?? null, to: r.sentToMasked ?? null, reason: r.reason ?? null });
      if (!r.ok) {
        const why = r.reason === 'no_destination' ? 'no mobile or email is on file for this client'
          : r.reason === 'too_many_sends' ? 'the maximum number of codes for this call has been sent'
          : 'the code could not be delivered right now';
        return J({ status: 'not_sent', reason: why, next: 'offer to have their broker place the order, or a callback' });
      }
      // Only a caller-ID-nominated candidate hears the destination's last digits; a self-named candidate
      // (anyone can name a client) is told "the mobile on file" and nothing more.
      const nominatedByLine = session.candidate.by === 'caller_id' || session.candidate.by === 'test_map' || session.candidate.by === 'request';
      const where = r.channel === 'sms' ? (nominatedByLine ? `the mobile ending in ${spokenTail(r.sentToMasked)}` : 'the mobile number on file')
        : (nominatedByLine ? `the email address on file (${r.sentToMasked})` : 'the email address on file');
      return J({ status: 'sent', channel: r.channel, sent_to: where, expires_in_seconds: voiceConfig.otpTtlSeconds, next: 'ask the caller to read the six digits back, then call check_verification_code' });
    },
  }));

  tools.push(voiceTool({
    name: 'check_verification_code',
    tier: 0,
    description: 'Check the six-digit code the caller read back. On success the caller is verified for account information AND trading.',
    shape: ({ code: z.string().describe('the digits the caller said (spaces/words allowed)') }),
    handler: async (a) => {
      if (!session.candidate) return J({ status: 'no_candidate' });
      const digits = wordsToDigits(String(a.code ?? ''));
      const v = await identity.checkOtp(session.id, session.candidate.uid, digits);
      if (v === 'verified') { await session.grant(2, 'otp'); return J({ status: 'verified', level: 'trading', first_name: session.candidate.firstName }); }
      await session.event('otp_failed', { result: v });
      const next = v === 'locked' ? 'no more attempts — offer to have their broker place the order, or a callback'
        : v === 'expired' ? 'the code has expired — offer to send a new one' : v === 'none' ? 'no code has been sent yet — send_verification_code first' : 'ask them to try once more, digit by digit';
      return J({ status: v, next });
    },
  }));

  tools.push(voiceTool({
    name: 'verify_caller_details',
    tier: 0,
    description: 'Optional extra check, only when something about the call seems off (the caller-ID match sounds wrong, hesitant answers): TWO ' +
      'account facts given together — both must match. Not needed for account information after a name confirmation, and ' +
      'never enough for orders (those need the one-time code). Facts: customer number, date of ' +
      'birth, the email on file, postcode, ABN. At least one must be private (customer number, date of birth or ' +
      'email); postcode and ABN are public and never enough on their own, and a fact already used to identify the ' +
      'caller does not count again. Ask for both facts first, then call once; the result is only verified or not — ' +
      'it never says which fact failed. Three attempts per call. Do not suggest answers.',
    shape: ({
      postcode: z.string().optional(), customer_number: z.string().optional(), abn: z.string().optional(),
      date_of_birth: z.string().optional().describe('as spoken, e.g. "14 May 1970"'), email: z.string().optional(),
    }),
    handler: async (a) => {
      if (!session.candidate) return J({ status: 'no_candidate' });
      const uid = session.candidate.uid;
      const retryMsg = 'the facts did not verify — offer the one-time code (send_verification_code), or a broker callback';
      if (session.knowledgeAttempts >= voiceConfig.knowledgeMaxAttemptsPerCall) {
        return J({ status: 'locked', next: 'no more account-fact attempts on this call — offer the one-time code or a broker callback' });
      }
      if ((await store.countKnowledgeAttemptsForClient(uid, 60)) >= voiceConfig.knowledgeMaxAttemptsPerClientHour) {
        await session.event('knowledge_locked', { uid, reason: 'per_client_hourly_cap' });
        return J({ status: 'locked', next: 'account-fact verification is temporarily unavailable for this account — offer the one-time code or a broker callback' });
      }
      // Facts the caller used to identify the account are struck before checking; a verdict is only
      // given when two (remaining) facts are supplied TOGETHER — no fact-by-fact probing.
      const answers: Record<string, any> = {};
      for (const k of ['postcode', 'customer_number', 'abn', 'date_of_birth', 'email'] as const) {
        if (String(a[k] ?? '').trim() && !session.identificationFacts.has(k)) answers[k] = a[k];
      }
      const supplied = Object.keys(answers);
      if (supplied.length < 2) {
        return J({ status: 'need_two_facts', next: 'ask for two account facts together (at least one of customer number / date of birth / email; a fact already used to find the account does not count), then call again' });
      }
      session.knowledgeAttempts++;
      const r = await identity.checkKnowledge(uid, answers);
      const hasPrivate = ['customer_number', 'date_of_birth', 'email'].some((f) => r.matchedFactors.includes(f));
      const verified = r.matched >= 2 && hasPrivate;
      // One 'knowledge_checked' event per attempt (the per-client hourly cap counts these by detail.uid);
      // grant() adds the 'knowledge_verified' event on success.
      await session.event('knowledge_checked', { uid, attempt: session.knowledgeAttempts, checked: r.checked, matched: r.matched, has_private: hasPrivate, verified });
      if (verified) { await session.grant(1, 'knowledge'); return J({ status: 'verified', level: 'account_information' }); }
      const left = voiceConfig.knowledgeMaxAttemptsPerCall - session.knowledgeAttempts;
      return J({ status: 'not_verified', attempts_left: left,
        next: left > 0 ? `${retryMsg}; or ask for two facts again (${left} attempt${left === 1 ? '' : 's'} left), without hinting which did not match`
          : 'no more account-fact attempts on this call — offer the one-time code or a broker callback' });
    },
  }));

  tools.push(voiceTool({
    name: 'confirm_prepared_order',
    tier: 2,
    description: 'Place a prepared order AFTER the caller has heard the read-back and answered your confirm-and-accept-terms ' +
      'question. The server checks the caller\'s actual last words AND that your read-back contained the order\'s ' +
      'volume and price: only a clear yes with no changes places the order; anything else is refused and you must ' +
      'go back to the caller. Never call this before they answer.',
    shape: ({ pending_order_id: z.number().int() }),
    handler: async (a) => {
      const id = Number(a.pending_order_id);
      const prep = session.preparedOrders.get(id);
      if (!prep) return J({ status: 'refused', reason: 'that order was not prepared on this call' });
      // The confirming "yes" must be a NEW caller utterance, spoken in a later turn than the prepare and
      // after a read-back that carried the figures — a "yes" to an earlier question is not consent.
      const t = session.lastTranscript;
      let userIdx = -1;
      for (let i = t.length - 1; i >= 0; i--) if (t[i]?.role === 'user') { userIdx = i; break; }
      // Agent utterances spoken after the prepare and before the caller's answer: index >= the anchor.
      const agentsAfter: string[] = [];
      let agentSeen = 0;
      for (let i = 0; i < userIdx; i++) {
        if (t[i]?.role !== 'agent') continue;
        if (agentSeen >= prep.agentUtterances) agentsAfter.push(String(t[i]?.content ?? ''));
        agentSeen++;
      }
      const readback = agentsAfter.join(' ');
      if (session.readbackThisTurn || session.turnCount <= prep.turn || userIdx < 0 || !agentsAfter.length) {
        await session.event('order_confirm_refused', { pending_order_id: id, verdict: 'premature', turn: session.turnCount, prepared_turn: prep.turn });
        return J({ status: 'not_confirmed', verdict: 'premature',
          next: 'the caller has not yet answered the read-back question — read the order back now, ask "Do you confirm this order and accept the terms and conditions?", and wait for their answer' });
      }
      const missing = readbackMissingFigures(readback, prep);
      if (missing.length) {
        await session.event('order_confirm_refused', { pending_order_id: id, verdict: 'readback_incomplete', missing });
        return J({ status: 'not_confirmed', verdict: 'readback_incomplete', missing,
          next: `your read-back did not state the ${missing.join(' and ')} — read the full order back (volume in megalitres and price per megalitre exactly as prepared), ask the confirm-and-accept-terms question again, and wait for the answer` });
      }
      const said = String(t[userIdx]?.content ?? '');
      const verdict = classifyAffirmation(said, session.language);
      if (verdict !== 'yes') {
        await session.event('order_confirm_refused', { pending_order_id: id, verdict, said: (said ?? '').slice(0, 200) });
        return J({ status: 'not_confirmed', caller_said: said ?? '', verdict,
          next: verdict === 'no' ? 'the caller did not confirm — ask what to change, discard_prepared_order if needed' : 'the answer was unclear — ask again plainly: "Do you confirm the order and accept the terms and conditions, yes or no?"' });
      }
      const ctx = session.ctxFor(2);
      try {
        const po = await confirmPendingOrder(ctx, id, true);
        if (po.status === 'placed') {
          await session.event('order_confirmed', { pending_order_id: id, crm_order_id: po.crm_order_id, cleared_trades: po.cleared_trades });
          await session.setOutcome('order_placed');
          session.preparedOrders.delete(id);
          return J({ status: 'placed', order_number: po.crm_order_id, cleared_trades: po.cleared_trades ?? 0, description: describeOrder(po),
            note: 'Tell the caller the order number and that their broker has been notified. A cleared_trades > 0 means it matched immediately.' });
        }
        await session.event('order_failed', { pending_order_id: id, status: po.status, error: po.error });
        return J({ status: po.status, error: po.error ?? null, next: 'apologise; the order was NOT placed; offer to escalate to their broker' });
      } catch (e: any) {
        if (e instanceof SeamUnknownOutcome) {
          await session.event('order_unknown_outcome', { pending_order_id: id });
          return J({ status: 'unknown_outcome', next: 'tell the caller the placement is being verified and their broker will confirm; do NOT retry' });
        }
        if (e instanceof ScopeViolation) return J({ status: 'REFUSED_OUT_OF_SCOPE', reason: e.message });
        throw e;
      }
    },
  }));

  tools.push(voiceTool({
    name: 'discard_prepared_order',
    tier: 2,
    description: 'Discard a prepared (not yet placed) order — when the caller changes their mind or wants different terms.',
    shape: ({ pending_order_id: z.number().int() }),
    handler: async (a) => {
      const id = Number(a.pending_order_id);
      if (!session.preparedOrders.has(id)) return J({ status: 'refused', reason: 'not prepared on this call' });
      const po = await cancelPendingOrder(session.ctxFor(2).uid, id);
      session.preparedOrders.delete(id);
      await session.event('order_discarded', { pending_order_id: id });
      return J({ status: po.status });
    },
  }));

  tools.push(voiceTool({
    name: 'escalate_to_broker',
    tier: 0,
    description: 'Hand the caller to a human Waterfind broker: records the escalation with a short summary on the client\'s ' +
      'CRM file so the broker has context, then transfers the call if a broker line is available, otherwise books a ' +
      'callback. Use when the caller asks for a person, when the matter is legal/complex/a price negotiation, when ' +
      'verification fails on a sensitive request, or when you cannot help. Tell the caller what will happen BEFORE ' +
      'calling this. If the caller is unidentified, the callback is recorded against the phone number only.',
    shape: ({
      reason: z.string().describe('short category, e.g. "requested a person", "legal question", "price negotiation"'),
      summary: z.string().describe('2-4 sentences a broker needs: who, what they want, what has been established on this call'),
      prefer: z.enum(['transfer', 'callback']).optional().describe('caller preference if stated'),
    }),
    handler: async (a) => {
      const reason = String(a.reason ?? 'escalation requested').slice(0, 200);
      const summary = String(a.summary ?? '').slice(0, 1500);
      const callerLine = session.fromNumber ? ` Caller number: ${session.fromNumber}.` : '';
      // An UNVERIFIED candidate (caller-ID match or a claimed name) still gets a task on the file — a
      // receptionist would take the message too — but it is labelled so, and carries no assertion that
      // the client said anything. Verified callers file a normal escalation.
      const unverified = session.authLevel < 1;
      const label = unverified ? `[phone call — UNVERIFIED caller, ${session.candidate?.by === 'self' ? 'claimed to be' : 'caller-ID matched'} ${session.candidate?.displayName ?? 'the client'}] ` : '[phone call] ';
      let crmTaskId: number | null = null;
      let brokerName = 'the Waterfind broking team';
      let transferTo: string | null = null;
      if (session.ctx && session.candidate) {
        // Durable escalation + CRM task in one step: on a call, the caller's spoken request IS the confirmation.
        const { escalation } = await prepareEscalation(session.ctx, { reason: unverified ? `[unverified] ${reason}` : reason, summary: `${label}${summary}${callerLine}` });
        const res = await confirmEscalation(session.ctx, escalation.id);
        crmTaskId = res.crmBrokerActionId;
        brokerName = res.broker.brokerName;
        transferTo = await brokerTransferNumber(res.broker.brokerUserId);
      } else {
        // Unidentified caller: no account to file against; still leave a task for the desk if we can.
        const anon = session.ctxFor(0);
        const broker = await resolveBroker(anon);
        try {
          crmTaskId = await insertBrokerActionForUnknown(reason, `${summary}${callerLine}`);
        } catch { crmTaskId = null; }
        brokerName = broker.brokerName;
      }
      // Transfer targets come ONLY from our own records: the assigned broker's CRM number, else the
      // configured desk number. Nothing the caller says (no tool argument) can name a transfer target.
      if (!transferTo) transferTo = voiceConfig.transferNumber ?? null;
      // Business hours apply to transfers; the weekend-only dialer rule (callingWeekdaysOnly) is the
      // OUTBOUND dialer's — a caller who rings on a Saturday may still be put through if hours allow.
      const canTransfer = voiceConfig.transferEnabled && !!transferTo && a.prefer !== 'callback' && withinHours(new Date());
      await session.event('escalated', { reason, crm_task_id: crmTaskId, transfer: canTransfer, target: canTransfer ? maskedTarget(transferTo!) : null });
      if (canTransfer) {
        session.pendingTransfer = transferTo!;
        // 'transferred' is set only when Retell confirms (call_ended with disconnection_reason
        // call_transfer → webhooks.ts); until then the outcome is 'transfer_requested'.
        await session.setOutcome('transfer_requested');
        return J({ status: 'transferring', broker: brokerName, crm_task_recorded: crmTaskId != null,
          next: 'say one short goodbye sentence ("I\'ll put you through now") — the transfer happens when you finish speaking' });
      }
      await session.setOutcome('callback_requested');
      return J({ status: 'callback_recorded', broker: brokerName, crm_task_recorded: crmTaskId != null,
        next: `tell the caller ${brokerName} will call them back${session.fromNumber ? ' on this number' : ''} during business hours; if the task could not be recorded, give them Waterfind's number ${voiceConfig.companyPhoneSpoken}` });
    },
  }));

  tools.push(voiceTool({
    name: 'request_callback',
    tier: 0,
    description: 'Book a broker callback without transferring (caller prefers a call back, or it is after hours). Records a task on the client\'s CRM file with the summary and the number to call.',
    shape: ({
      summary: z.string().describe('what the caller wants, 1-3 sentences'),
      best_time: z.string().optional().describe('as spoken, e.g. "tomorrow morning"'),
      number: z.string().optional().describe('a different number to call back on, if the caller gave one'),
    }),
    handler: async (a) => {
      const num = a.number ? toE164(a.number) : session.fromNumber;
      const unverified = session.authLevel < 1;
      const label = unverified ? `[phone call — UNVERIFIED caller, ${session.candidate?.by === 'self' ? 'claimed to be' : 'caller-ID matched'} ${session.candidate?.displayName ?? 'the client'}] ` : '[phone call] ';
      const text = `${label}Callback requested. ${String(a.summary ?? '').slice(0, 1200)}${a.best_time ? ` Best time: ${String(a.best_time).slice(0, 100)}.` : ''}${num ? ` Number: ${num}.` : ''}`;
      let taskId: number | null = null;
      if (session.ctx && session.candidate) {
        const broker = await resolveBroker(session.ctx);
        taskId = await insertBrokerAction(session.ctx, broker, { title: unverified ? 'AI phone assistant: callback requested (unverified caller)' : 'AI phone assistant: callback requested', description: text, tradeAction: false });
      } else {
        try { taskId = await insertBrokerActionForUnknown('callback requested', text); } catch { taskId = null; }
      }
      await session.event('callback_requested', { crm_task_id: taskId, number: num ? maskedTarget(num) : null });
      await session.setOutcome('callback_requested');
      return J({ status: taskId != null ? 'recorded' : 'not_recorded', next: taskId != null ? 'confirm the callback to the caller' : `could not record it — give the caller Waterfind's number ${voiceConfig.companyPhoneSpoken}` });
    },
  }));

  tools.push(voiceTool({
    name: 'record_do_not_call',
    tier: 0,
    description: 'The caller asks not to receive calls from the Waterfind assistant (or any automated calls). Adds their number to the suppression list immediately and, when the client is known, records it on their CRM file (a Contact Note, and "Include in Campaigns" switched off). Then apologise briefly and end the call unless they still want something.',
    shape: ({ scope: z.enum(['automated_calls', 'all_calls']).optional() }),
    handler: async (a) => {
      const num = session.isOutbound ? session.toNumber : session.fromNumber;
      const digits = normalizeDigits(num);
      const scope = a.scope ?? 'automated_calls';
      if (digits) await store.addSuppression(digits, 'opt_out', `call:${session.retellCallId}`);
      session.optedOut = true;
      // CRM write-through (the two records a broker would make): best-effort, each half reported.
      let crm: { noteWritten: boolean; campaignOptinOff: boolean } | { error: string } | null = null;
      if (session.candidate) {
        const when = new Date().toLocaleString('en-AU', { timeZone: voiceConfig.timezone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const note = `Client asked not to receive ${scope === 'all_calls' ? 'calls' : 'automated calls'} from Waterfind (AI assistant, ${session.isOutbound ? 'outbound' : 'inbound'} call, ${when}). Number ending ${maskedTarget(num)} added to the do-not-call list; "Include in Campaigns" switched off.`;
        try { crm = await recordOptOutInCrm({ clientUid: session.candidate.uid, accountId: session.candidate.accountId, note, idemKey: `optout-${session.retellCallId}` }); }
        catch (e: any) { crm = { error: String(e?.message ?? e).slice(0, 200) }; console.error(`[voice] opt-out CRM write-through failed on call ${session.retellCallId}:`, e?.message ?? e); }
      }
      await session.event('opted_out', { scope, number: maskedTarget(num), crm });
      await session.setOutcome('opted_out');
      return J({ status: digits ? 'suppressed' : 'no_number', crm_file: crm && 'noteWritten' in crm ? (crm.noteWritten && crm.campaignOptinOff ? 'updated' : 'partly updated') : (crm ? 'not updated' : 'no client on this call'),
        next: 'acknowledge in one sentence; end the call if there is nothing else' });
    },
  }));

  tools.push(voiceTool({
    name: 'end_call',
    tier: 0,
    description: 'Hang up after your goodbye. Call this only when the conversation is finished (caller said goodbye / nothing else needed / after an opt-out). Say the goodbye in the same turn; the line drops when you finish speaking.',
    shape: ({ reason: z.string().optional() }),
    handler: async (a) => {
      session.pendingEndCall = true;
      if (!session.outcome) await session.setOutcome('completed');
      await session.event('end_call_requested', { reason: a.reason ?? null });
      return J({ status: 'ending', next: 'say goodbye now' });
    },
  }));

  return tools;
}

/** "one two three four five six" / "1 2 3 4 5 6" / "123456" → "123456". */
export function wordsToDigits(s: string): string {
  const map: Record<string, string> = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
  return s.toLowerCase().split(/[^a-z0-9]+/).map((t) => (map[t] ?? t)).join('').replace(/\D/g, '');
}

// ---- read-back figure check ------------------------------------------------------------------

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000 };
const HALF = /\b(?:a|one) half\b|\band a half\b/;

/**
 * Every number the text states — as digits ("9,990", "$1,234.50", "450") or as English words ("nine
 * thousand nine hundred and ninety", "ninety-five", "two hundred", "one point five") — so a spoken
 * read-back can be checked for the order's figures however the model chose to voice them.
 */
export function numbersInText(text: string): number[] {
  const out: number[] = [];
  const t = text.toLowerCase().replace(/[’‘]/g, '\'');
  // Digits, allowing thousands separators and decimals. Drop commas inside numbers first.
  for (const m of t.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  // Locales that group thousands with a dot and mark decimals with a comma ("9.500 dollari", "95,50 euro"):
  // a read-back in the caller's language is checked by its digits, so both readings are candidates.
  for (const m of t.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{3})+(?![\d.])/g)) out.push(Number(m[0].replace(/\./g, '')));
  for (const m of t.matchAll(/(?<![\d,])(\d+),(\d{1,2})(?![\d,])/g)) out.push(Number(`${m[1]}.${m[2]}`));
  // Word numbers: scan tokens, accumulating a number phrase; "and" and hyphens join.
  const tokens = t.replace(/-/g, ' ').split(/[^a-z0-9.]+/).filter(Boolean);
  let total = 0, current = 0, inNumber = false, sawScale = false;
  let last: 'units' | 'tens' | 'scale' | 'and' | null = null;   // what the previous number word was
  const flush = () => { if (inNumber) out.push(total + current); total = 0; current = 0; inNumber = false; sawScale = false; last = null; };
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (w in SMALL) {
      const v = SMALL[w];
      const kind: 'units' | 'tens' = v >= 20 ? 'tens' : 'units';
      // A tens word after units/tens, or a units word after units, starts a NEW number ("ninety five
      // fifty" = 95 then 50; "nine nine zero" = 9, 9, 0) — only tens→units ("twenty one") and anything
      // after a scale word or "and" continue the same number.
      if (inNumber && (last === 'units' || (last === 'tens' && kind === 'tens'))) flush();
      current += v; inNumber = true; last = kind; continue;
    }
    if (w in SCALE) {
      if (!inNumber) { current = 1; inNumber = true; }   // "a hundred", "hundred and fifty"
      if (w === 'hundred') current *= 100; else { total += (current || 1) * SCALE[w]; current = 0; }
      sawScale = true; last = 'scale'; continue;
    }
    if (w === 'and' && inNumber && sawScale) { last = 'and'; continue; }   // "nine thousand AND ninety"
    if (w === 'point' && inNumber) {
      // "one point five" → 1.5
      const frac: string[] = [];
      let j = i + 1;
      while (j < tokens.length && tokens[j] in SMALL && SMALL[tokens[j]] < 10) { frac.push(String(SMALL[tokens[j]])); j++; }
      if (frac.length) { out.push(Number(`${total + current}.${frac.join('')}`)); total = 0; current = 0; inNumber = false; sawScale = false; i = j - 1; continue; }
    }
    flush();
  }
  flush();
  // "one and a half megalitres" → 1.5 (in addition to the 1 already collected)
  if (HALF.test(t)) for (const n of [...out]) if (Number.isInteger(n)) out.push(n + 0.5);
  return out;
}

/** Which of the prepared order's figures (volume / price) the read-back text does not state. */
export function readbackMissingFigures(readback: string, prep: { volumeMl: number | null; pricePerMl: number | null }): string[] {
  const nums = numbersInText(readback);
  const has = (v: number) => nums.some((n) => Math.abs(n - v) < 1e-6 || (!Number.isInteger(v) && n === Math.floor(v)));
  const missing: string[] = [];
  if (prep.volumeMl != null && !has(prep.volumeMl)) missing.push('volume');
  if (prep.pricePerMl != null && !has(prep.pricePerMl)) missing.push('price');
  return missing;
}

function maskedTarget(n: string | null | undefined): string | null {
  if (!n) return null;
  const d = String(n).replace(/\D/g, '');
  return d ? '…' + d.slice(-3) : null;
}

/** The assigned broker's business number as an E.164 transfer target, if configured to use it. */
async function brokerTransferNumber(brokerUserId: number | null): Promise<string | null> {
  if (!voiceConfig.transferToAssignedBroker || !brokerUserId) return null;
  const r = await query(`SELECT businessphone, company_mobile FROM waterfind_user WHERE id=$1`, [brokerUserId]);
  const row = r.rows[0];
  if (!row) return null;
  return toE164(row.businessphone) ?? toE164(row.company_mobile) ?? null;
}

/** A broker_action for a caller we could not identify: filed against no client (client_registry_user is NOT NULL
 *  in the CRM), so it goes to the AIADVISOR_DEFAULT_BROKER_ID's own account if configured; else nothing. */
async function insertBrokerActionForUnknown(reason: string, description: string): Promise<number | null> {
  const deskUid = Number(process.env.AIADVISOR_DEFAULT_BROKER_ID);
  if (!Number.isInteger(deskUid) || deskUid <= 0) return null;
  const r = await query(`SELECT registry_user FROM waterfind_user WHERE id=$1`, [deskUid]);
  const account = r.rows[0]?.registry_user;
  if (!account) return null;
  const ins = await query<{ id: number }>(
    `INSERT INTO public.broker_action (id, creator_waterfind_user, client_registry_user, due_date, action_type,
        broker_action, company_action, trade_action, infrastructure_action, title, description, completed)
     VALUES (nextval('hibernate_sequence'), $1, $2, now(), 'call', true, false, false, false, $3, $4, false) RETURNING id`,
    [deskUid, account, plain(`AI phone assistant: ${reason}`, 250), plain(description, 1000)]);
  return ins.rows[0]?.id ?? null;
}

/** Tools → Messages API `tools` param, with the last one cache-marked. */
export function toApiTools(tools: VoiceTool[]): Anthropic.Tool[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as any,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

/**
 * The tier gate + stale-set gate + audit + error containment, shared by both model backends. A tool
 * above the session's verification level returns a structured refusal to the model; a tier>=1 tool
 * from a set built for a different candidate (the candidate changed earlier in this same turn) is
 * refused with a retry-next-turn note; a thrown handler error becomes a tool error result (never an
 * unhandled rejection mid-call).
 */
export async function dispatchTool(session: VoiceSession, tool: VoiceTool | undefined, name: string, args: any): Promise<{ text: string; isError: boolean }> {
  if (!tool) return { text: JSON.stringify({ error: 'unknown tool' }), isError: true };
  const currentUid = session.candidate?.uid ?? null;
  if (tool.tier >= 1 && tool.forUid !== currentUid) {
    await session.event('tool_refused_stale', { tool: name, built_for: tool.forUid, current: currentUid });
    return {
      isError: true,
      text: JSON.stringify({
        status: 'REFUSED_IDENTITY_CHANGED',
        note: 'the caller identity changed during this turn; account tools are rebuilt for the new candidate on your NEXT turn — finish this turn (tell the caller what you will check) and call the tool again after they reply',
      }),
    };
  }
  if (tool.tier > session.authLevel) {
    await session.event('tool_refused_tier', { tool: name, required: tool.tier, level: session.authLevel });
    return {
      isError: false,
      text: JSON.stringify({
        status: 'REFUSED_NOT_VERIFIED', current_level: session.authLevel,
        required: tool.tier === 2 ? 'one-time code verification (send_verification_code / check_verification_code)' : 'the caller confirming they are the client (confirm_caller_identity), or identify_caller with their name and one account detail',
        note: session.candidate ? 'the caller is not yet verified to this level' : 'no caller identified yet — identify_caller first',
      }),
    };
  }
  try {
    await session.event('tool_call', { tool: name });
    // A hung tool (CRM seam, DB) must not silence the line: time-box it; the turn then apologises/offers a broker.
    const r = await Promise.race([
      tool.handler(args ?? {}),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`tool timed out after ${voiceConfig.toolTimeoutMs} ms`)), voiceConfig.toolTimeoutMs).unref?.()),
    ]);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  } catch (e: any) {
    console.error(`[voice] tool ${name} failed on call ${session.id}:`, e?.message ?? e);
    return { text: JSON.stringify({ error: 'tool failed', detail: String(e?.message ?? e).slice(0, 200) }), isError: true };
  }
}
